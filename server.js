const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");

const publicDir = path.join(__dirname, "public");
const colors = new Set(["red", "blue", "yellow", "green", "white"]);
const clients = new Map();
const sessions = new Map();
const messages = [];
let lockOwnerId = null;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const file = pathname === "/" ? "index.html" : path.basename(pathname);
  const filePath = path.join(publicDir, file);

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(file)] || "application/octet-stream",
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

wss.on("connection", (socket) => {
  const client = { id: randomUUID(), name: "ゲスト", color: "white", isAdmin: false, joined: false };
  clients.set(socket, client);

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "不正なメッセージです。" }));
      return;
    }
    if (!data || typeof data !== "object") {
      socket.send(JSON.stringify({ type: "error", message: "不正なメッセージです。" }));
      return;
    }

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
      client.joined = true;
      socket.send(JSON.stringify({
        type: "welcome",
        id: client.id,
        resumeToken: client.resumeToken,
        isAdmin: client.isAdmin,
        messages,
        lockedBy: lockOwnerId,
        peers: [...clients.values()].filter((peer) => peer.joined && peer !== client).map(({ id }) => id),
      }));
      broadcast({ type: "peer-joined", id: client.id }, socket);
      return;
    }

    if (!client.joined) {
      socket.send(JSON.stringify({ type: "error", message: "先にチャットへ参加してください。" }));
      return;
    }

    if (data.type === "lock-toggle") {
      lockOwnerId = lockOwnerId === null ? client.id : null;
      broadcast({ type: "lock", lockedBy: lockOwnerId });
      return;
    }

    if (data.type === "admin-enable") {
      if (data.code !== "888") {
        socket.send(JSON.stringify({ type: "error", message: "管理者コマンドが無効です。" }));
        return;
      }
      const session = sessions.get(client.resumeToken);
      if (!session) {
        socket.send(JSON.stringify({ type: "error", message: "管理者セッションがありません。" }));
        return;
      }
      client.isAdmin = true;
      session.isAdmin = true;
      socket.send(JSON.stringify({ type: "admin-enabled" }));
      return;
    }

    if (data.type === "color") {
      if (!colors.has(data.color)) {
        socket.send(JSON.stringify({ type: "error", message: "色を選択してください。" }));
        return;
      }
      client.color = data.color;
      messages
        .filter((message) => message.authorId === client.id)
        .forEach((message) => { message.color = client.color; });
      broadcast({ type: "color", authorId: client.id, color: client.color });
      return;
    }

    if (data.type === "rename") {
      const name = typeof data.name === "string" ? data.name.trim().slice(0, 24) : "";
      if (!name) {
        socket.send(JSON.stringify({ type: "error", message: "ユーザー名を入力してください。" }));
        return;
      }
      client.name = name;
      const ownMessageIds = new Set();
      messages.forEach((message) => {
        if (message.authorId === client.id) {
          message.name = name;
          ownMessageIds.add(message.id);
        }
      });
      messages.forEach((message) => {
        if (message.replyTo && ownMessageIds.has(message.replyTo.id)) message.replyTo.name = name;
      });
      broadcast({ type: "name", authorId: client.id, name });
      return;
    }

    if (data.type === "message") {
      const text = typeof data.text === "string" ? data.text.trim().slice(0, 4000) : "";
      let attachment;
      if (data.attachment && typeof data.attachment.data === "string") {
        const { data: fileData, name, mime } = data.attachment;
        const allowedMime = typeof mime === "string" && /^(image|video)\/[a-zA-Z0-9.+-]+$/.test(mime);
        const encodedLimit = 11_200_000;
        const prefix = `data:${mime};base64,`;
        const base64 = fileData.startsWith(prefix) ? fileData.slice(prefix.length) : "";
        const validBase64 = base64.length > 0 &&
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64);
        if (!allowedMime || fileData.length > encodedLimit || !validBase64 ||
            Buffer.from(base64, "base64").length > 8 * 1024 * 1024) {
          socket.send(JSON.stringify({ type: "error", message: "画像・動画は8MB以下の対応形式を選択してください。" }));
          return;
        }
        attachment = {
          data: fileData,
          name: typeof name === "string" ? name.slice(0, 255) : "ファイル",
          mime,
        };
      }
      if (!text && !attachment) {
        socket.send(JSON.stringify({ type: "error", message: "メッセージか画像・動画を入力してください。" }));
        return;
      }

      const replyTo = messages.find((message) => message.id === data.replyTo);
      const message = {
        id: randomUUID(),
        authorId: client.id,
        name: client.name,
        color: client.color,
        text,
        attachment,
        replyTo: replyTo ? {
          id: replyTo.id,
          authorId: replyTo.authorId,
          name: replyTo.name,
          text: replyTo.text || replyTo.attachment?.name || "",
        } : null,
      };
      messages.push(message);
      broadcast({ type: "message", message });
      return;
    }

    if (data.type === "delete") {
      const index = messages.findIndex((message) =>
        message.id === data.id && (message.authorId === client.id || client.isAdmin)
      );
      if (index !== -1) {
        messages.splice(index, 1);
        broadcast({ type: "delete", id: data.id });
      }
      return;
    }

    if (data.type === "signal" && typeof data.to === "string") {
      const recipient = [...clients].find(([, peer]) => peer.joined && peer.id === data.to)?.[0];
      if (recipient?.readyState === WebSocket.OPEN) {
        recipient.send(JSON.stringify({ type: "signal", from: client.id, signal: data.signal }));
      }
    }
  });

  socket.on("close", () => {
    clients.delete(socket);
    if (client.joined) {
      broadcast({ type: "peer-left", id: client.id });
    }
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", () => console.log(`Chat is running at http://localhost:${port}`));
