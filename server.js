const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, timingSafeEqual } = require("node:crypto");
const { Client, ID, Query, Storage, TablesDB } = require("node-appwrite");
const { WebSocketServer, WebSocket } = require("ws");

const requiredEnv = [
  "APPWRITE_ENDPOINT",
  "APPWRITE_PROJECT_ID",
  "APPWRITE_DATABASE_ID",
  "APPWRITE_TABLE_ID",
  "APPWRITE_BUCKET_ID",
  "APPWRITE_API_KEY",
  "ADMIN_CODE",
];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) throw new Error(`Missing required environment variables: ${missingEnv.join(", ")}`);

const appwriteConfig = {
  endpoint: process.env.APPWRITE_ENDPOINT.replace(/\/+$/, ""),
  projectId: process.env.APPWRITE_PROJECT_ID,
  databaseId: process.env.APPWRITE_DATABASE_ID,
  tableId: process.env.APPWRITE_TABLE_ID,
  bucketId: process.env.APPWRITE_BUCKET_ID,
};
const appwriteClient = new Client()
  .setEndpoint(appwriteConfig.endpoint)
  .setProject(appwriteConfig.projectId)
  .setKey(process.env.APPWRITE_API_KEY);
const tables = new TablesDB(appwriteClient);
const storage = new Storage(appwriteClient);

const publicDir = path.join(__dirname, "public");
const colors = new Set(["red", "blue", "yellow", "green", "black", "white"]);
const clients = new Map();
const sessions = new Map();
let lockOwnerId = null;
let maintenanceMode = false;
let pinnedMessageId = null;
const retentionMs = 72 * 60 * 60 * 1000;
const pageSize = 100;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const adminCode = Buffer.from(process.env.ADMIN_CODE);
const adminAttempts = new Map();
const aiCrawlerPattern = /(?:GPTBot|ChatGPT-User|ClaudeBot|anthropic-ai|PerplexityBot|Google-Extended|CCBot|Bytespider|Meta-ExternalAgent|YouBot)/i;

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self' ws: wss: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function adminCodeMatches(code) {
  if (typeof code !== "string") return false;
  const supplied = Buffer.from(code);
  return supplied.length === adminCode.length && timingSafeEqual(supplied, adminCode);
}

const server = http.createServer((request, response) => {
  setSecurityHeaders(response);
  const userAgent = request.headers["user-agent"] || "";
  if (aiCrawlerPattern.test(userAgent)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("Forbidden");
    return;
  }
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (request.method === "GET" && pathname === "/ping") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("OK");
    return;
  }
  if (request.method === "GET" && pathname === "/robots.txt") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("User-agent: *\nDisallow: /\n");
    return;
  }
  const file = pathname === "/" ? "index.html" : path.basename(pathname);
  const filePath = path.join(publicDir, file);

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 12 * 1024 * 1024 });

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "heartbeat" }));
    }
  }
}, 15000);

wss.on("close", () => clearInterval(heartbeat));

function broadcast(data, except) {
  const packet = JSON.stringify(data);
  for (const [socket, client] of clients) {
    if (client.joined && socket !== except && socket.readyState === WebSocket.OPEN) socket.send(packet);
  }
}

function sendError(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "error", message }));
  }
}

function rowToMessage(row) {
  let replyTo = null;
  if (row.replyTo) {
    try {
      replyTo = JSON.parse(row.replyTo);
    } catch (error) {
      console.error(`Invalid replyTo JSON in message ${row.$id}:`, error);
    }
  }
  const message = {
    id: row.$id,
    authorId: row.senderId,
    name: row.name,
    color: row.color,
    text: row.text || "",
    replyTo,
  };
  if (row.fileId) {
    message.attachment = {
      fileId: row.fileId,
      name: row.fileName,
      mime: row.fileMime,
      url: `${appwriteConfig.endpoint}/storage/buckets/${encodeURIComponent(appwriteConfig.bucketId)}/files/${encodeURIComponent(row.fileId)}/view?project=${encodeURIComponent(appwriteConfig.projectId)}`,
    };
  }
  return message;
}

async function listRows(queries = []) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const result = await tables.listRows({
      databaseId: appwriteConfig.databaseId,
      tableId: appwriteConfig.tableId,
      queries: [...queries, Query.limit(pageSize), Query.offset(offset)],
      total: false,
    });
    rows.push(...result.rows);
    if (result.rows.length < pageSize) return rows;
  }
}

async function getRecentMessages() {
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const rows = await listRows([
    Query.greaterThanEqual("$createdAt", cutoff),
    Query.orderAsc("$createdAt"),
  ]);
  return rows.map(rowToMessage);
}

function isNotFound(error) {
  return error && (error.code === 404 || error.status === 404);
}

async function deleteFileIfPresent(fileId) {
  if (!fileId) return;
  try {
    await storage.deleteFile({ bucketId: appwriteConfig.bucketId, fileId });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

let cleanupRunning = false;
async function deleteExpiredMessages() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    while (true) {
      const result = await tables.listRows({
        databaseId: appwriteConfig.databaseId,
        tableId: appwriteConfig.tableId,
        queries: [
          Query.lessThanEqual("$createdAt", cutoff),
          Query.orderAsc("$createdAt"),
          Query.limit(1),
        ],
        total: false,
      });
      const row = result.rows[0];
      if (!row) break;
      await deleteFileIfPresent(row.fileId);
      await tables.deleteRow({
        databaseId: appwriteConfig.databaseId,
        tableId: appwriteConfig.tableId,
        rowId: row.$id,
      });
      if (pinnedMessageId === row.$id) {
        pinnedMessageId = null;
        broadcast({ type: "pinned-message", id: null });
      }
    }
  } catch (error) {
    console.error("Expired-message cleanup failed:", error);
  } finally {
    cleanupRunning = false;
  }
}

async function keepAppwriteAlive() {
  try {
    await tables.listRows({
      databaseId: appwriteConfig.databaseId,
      tableId: appwriteConfig.tableId,
      queries: [Query.limit(1)],
      total: false,
    });
  } catch (error) {
    console.error("Appwrite keep-alive read failed:", error);
  }
}

function updateRow(rowId, data) {
  return tables.updateRow({
    databaseId: appwriteConfig.databaseId,
    tableId: appwriteConfig.tableId,
    rowId,
    data,
  });
}

async function renameMessages(authorId, name) {
  const rows = await listRows();
  const senderById = new Map(rows.map((row) => [row.$id, row.senderId]));
  for (const row of rows) {
    let update;
    if (row.senderId === authorId) update = { name };
    if (row.replyTo) {
      try {
        const replyTo = JSON.parse(row.replyTo);
        if (senderById.get(replyTo.id) === authorId && replyTo.name !== name) {
          update = { ...update, replyTo: JSON.stringify({ ...replyTo, name }) };
        }
      } catch (error) {
        console.error(`Invalid replyTo JSON in message ${row.$id}:`, error);
      }
    }
    if (update) await updateRow(row.$id, update);
  }
}

async function recolorMessages(authorId, color) {
  const rows = await listRows([Query.equal("senderId", authorId)]);
  for (const row of rows) await updateRow(row.$id, { color });
}

async function createMessage(data, client) {
  const text = typeof data.text === "string" ? data.text.trim().slice(0, 4000) : "";
  let fileId = "";
  let fileName = "";
  let fileMime = "";
  if (data.fileId !== undefined || data.fileName !== undefined || data.fileMime !== undefined) {
    if (typeof data.fileId !== "string" || !data.fileId ||
        typeof data.fileName !== "string" || typeof data.fileMime !== "string" ||
        !/^(image|video)\/[a-zA-Z0-9.+-]+$/.test(data.fileMime)) {
      throw new Error("画像・動画のアップロード情報が無効です。");
    }
    const file = await storage.getFile({ bucketId: appwriteConfig.bucketId, fileId: data.fileId });
    if (!/^(image|video)\//.test(file.mimeType) || file.sizeOriginal > 330 * 1024 * 1024) {
      throw new Error("画像・動画は対応形式の330MB以下にしてください。");
    }
    fileId = file.$id;
    fileName = file.name.slice(0, 255);
    fileMime = file.mimeType;
  }
  if (!text && !fileId) throw new Error("メッセージか画像・動画を入力してください。");

  let replyTo;
  if (typeof data.replyTo === "string") {
    try {
      const row = await tables.getRow({
        databaseId: appwriteConfig.databaseId,
        tableId: appwriteConfig.tableId,
        rowId: data.replyTo,
      });
      if (Date.now() - new Date(row.$createdAt).getTime() < retentionMs) replyTo = rowToMessage(row);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  const replySnapshot = replyTo ? {
    id: replyTo.id,
    authorId: replyTo.authorId,
    name: replyTo.name,
    text: replyTo.text || replyTo.attachment?.name || "",
  } : null;
  const row = await tables.createRow({
    databaseId: appwriteConfig.databaseId,
    tableId: appwriteConfig.tableId,
    rowId: ID.unique(),
    data: {
      senderId: client.id,
      name: client.name,
      color: client.color,
      text,
      replyTo: replySnapshot ? JSON.stringify(replySnapshot) : "",
      fileId,
      fileName,
      fileMime,
    },
  });
  return rowToMessage(row);
}

async function deleteMessage(messageId, client) {
  let row;
  try {
    row = await tables.getRow({
      databaseId: appwriteConfig.databaseId,
      tableId: appwriteConfig.tableId,
      rowId: messageId,
    });
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (row.senderId !== client.id && !client.isAdmin) return false;
  await deleteFileIfPresent(row.fileId);
  await tables.deleteRow({
    databaseId: appwriteConfig.databaseId,
    tableId: appwriteConfig.tableId,
    rowId: messageId,
  });
  return true;
}

wss.on("connection", (socket) => {
  const client = { id: randomUUID(), name: "ゲスト", color: "white", isAdmin: false, joined: false };
  clients.set(socket, client);

  let messageQueue = Promise.resolve();
  socket.on("message", (raw) => {
    messageQueue = messageQueue.then(() => processMessage(raw)).catch((error) => {
      console.error("WebSocket request failed:", error);
      sendError(socket, "処理に失敗しました。");
    });
  });

  async function processMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      sendError(socket, "不正なメッセージです。");
      return;
    }
    if (!data || typeof data !== "object") {
      sendError(socket, "不正なメッセージです。");
      return;
    }

    try {
      if (data.type === "join") {
        if (client.joined) return;
        const session = typeof data.resumeToken === "string" ? sessions.get(data.resumeToken) : null;
        if (session) {
          client.id = session.id;
          client.isAdmin = session.isAdmin === true;
          client.resumeToken = data.resumeToken;
        } else {
          client.id = randomUUID();
          client.isAdmin = false;
          client.resumeToken = randomUUID();
          sessions.set(client.resumeToken, { id: client.id, isAdmin: false });
        }
        client.name = typeof data.name === "string" ? data.name.trim().slice(0, 24) || "ゲスト" : "ゲスト";
        client.color = colors.has(data.color) ? data.color : "white";
        const messages = await getRecentMessages();
        client.joined = true;
        socket.send(JSON.stringify({
          type: "welcome",
          id: client.id,
          resumeToken: client.resumeToken,
          isAdmin: client.isAdmin,
          messages,
          pinnedMessageId,
          lockedBy: lockOwnerId,
          maintenanceMode,
          peers: [...clients.values()].filter((peer) => peer.joined && peer !== client).map(({ id }) => id),
          appwrite: {
            endpoint: appwriteConfig.endpoint,
            projectId: appwriteConfig.projectId,
            bucketId: appwriteConfig.bucketId,
          },
        }));
        broadcast({ type: "peer-joined", id: client.id }, socket);
        return;
      }

      if (!client.joined) {
        sendError(socket, "先にチャットへ参加してください。");
        return;
      }

      if (data.type === "lock-toggle") {
        if (!client.isAdmin) {
          sendError(socket, "ロックモードは管理者メニューから操作してください。");
          return;
        }
        lockOwnerId = lockOwnerId === null ? client.id : null;
        broadcast({ type: "lock", lockedBy: lockOwnerId });
        return;
      }

      if (data.type === "admin-enable") {
        const now = Date.now();
        const attempts = adminAttempts.get(client.id) || { count: 0, retryAt: 0 };
        if (attempts.retryAt > now) {
          sendError(socket, "管理者認証をしばらくお待ちください。");
          return;
        }
        if (!adminCodeMatches(data.code)) {
          attempts.count += 1;
          if (attempts.count >= 5) attempts.retryAt = now + 15 * 60 * 1000;
          adminAttempts.set(client.id, attempts);
          sendError(socket, "管理者コードが無効です。");
          return;
        }
        adminAttempts.delete(client.id);
        const session = sessions.get(client.resumeToken);
        if (!session) {
          sendError(socket, "管理者セッションがありません。");
          return;
        }
        client.isAdmin = true;
        session.isAdmin = true;
        socket.send(JSON.stringify({ type: "admin-enabled" }));
        return;
      }

      if (data.type === "maintenance-toggle") {
        if (!client.isAdmin) {
          sendError(socket, "メンテナンスモードは管理者だけが切り替えられます。");
          return;
        }
        maintenanceMode = !maintenanceMode;
        broadcast({ type: "maintenance-mode", enabled: maintenanceMode });
        return;
      }

      if (data.type === "pin-next") {
        if (!client.isAdmin) {
          sendError(socket, "ピン留めは管理者だけ使用できます。");
          return;
        }
        client.pinNextMessage = data.enabled === true;
        socket.send(JSON.stringify({ type: "pin-next-state", enabled: client.pinNextMessage }));
        return;
      }

      if (data.type === "color") {
        if (!colors.has(data.color)) {
          sendError(socket, "色を選択してください。");
          return;
        }
        await recolorMessages(client.id, data.color);
        client.color = data.color;
        broadcast({ type: "color", authorId: client.id, color: client.color });
        return;
      }

      if (data.type === "rename") {
        const name = typeof data.name === "string" ? data.name.trim().slice(0, 24) : "";
        if (!name) {
          sendError(socket, "ユーザー名を入力してください。");
          return;
        }
        await renameMessages(client.id, name);
        client.name = name;
        broadcast({ type: "name", authorId: client.id, name });
        return;
      }

      if (data.type === "message") {
        const message = await createMessage(data, client);
        if (client.pinNextMessage) {
          client.pinNextMessage = false;
          pinnedMessageId = message.id;
          message.isPinned = true;
        }
        broadcast({ type: "message", message });
        if (message.isPinned) broadcast({ type: "pinned-message", id: pinnedMessageId });
        return;
      }

      if (data.type === "delete") {
        if (typeof data.id === "string" && await deleteMessage(data.id, client)) {
          broadcast({ type: "delete", id: data.id });
          if (pinnedMessageId === data.id) {
            pinnedMessageId = null;
            broadcast({ type: "pinned-message", id: null });
          }
        }
        return;
      }

      if (data.type === "signal" && typeof data.to === "string") {
        const recipient = [...clients].find(([, peer]) => peer.joined && peer.id === data.to)?.[0];
        if (recipient?.readyState === WebSocket.OPEN) {
          recipient.send(JSON.stringify({ type: "signal", from: client.id, signal: data.signal }));
        }
      }
    } catch (error) {
      console.error(`WebSocket ${data.type || "unknown"} request failed:`, error);
      sendError(socket, error.message || "処理に失敗しました。");
    }
  }

  socket.on("close", () => {
    clients.delete(socket);
    if (client.joined) {
      broadcast({ type: "peer-left", id: client.id });
    }
  });
});

void deleteExpiredMessages();
void keepAppwriteAlive();
setInterval(deleteExpiredMessages, 60 * 60 * 1000);
setInterval(keepAppwriteAlive, 24 * 60 * 60 * 1000);

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", () => console.log(`Chat is running at http://localhost:${port}`));
