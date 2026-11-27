const status = document.querySelector("#status");
const participantCount = document.querySelector("#participant-count");
const messagesEl = document.querySelector("#messages");
const textInput = document.querySelector("#text");
const fileInput = document.querySelector("#file");
const fileName = document.querySelector("#file-name");
const fileNameText = document.querySelector("#file-name-text");
const removeFileButton = document.querySelector("#remove-file");
const replyPreview = document.querySelector("#reply-preview");
const attachmentMenu = document.querySelector("#attachment-menu");
const attachmentMenuToggle = document.querySelector("#attachment-menu-toggle");
const pinNextButton = document.querySelector("#pin-next");
const adminSettings = document.querySelector("#admin-settings");
const adminSettingsToggle = document.querySelector("#admin-settings-toggle");
const adminSettingsMenu = document.querySelector("#admin-settings-menu");
const adminLockToggle = document.querySelector("#admin-lock-toggle");
const adminMaintenanceToggle = document.querySelector("#admin-maintenance-toggle");
const pinnedMessage = document.querySelector("#pinned-message");
const shareButton = document.querySelector("#share");
const colorSwatches = document.querySelectorAll(".color-swatch");
const displayName = document.querySelector("#display-name");

const nameParts = ["あお", "ゆき", "はる", "そら", "もも", "野獣先輩"];
const displayNameStorageKey = "chat-display-name";
const generatedName = `匿名${nameParts[Math.floor(Math.random() * nameParts.length)]}#${Math.floor(1000 + Math.random() * 9000)}`;
const anonymousName = localStorage.getItem(displayNameStorageKey)?.trim().slice(0, 24) || generatedName;
localStorage.setItem(displayNameStorageKey, anonymousName);
displayName.value = anonymousName;

let myId;
let joined = false;
let isAdmin = false;
let socket;
let reconnectTimer;
let reconnectDelay = 1000;
let resumeToken = sessionStorage.getItem("chat-resume-token");
let appwriteConfig;
let appwriteSessionPromise;
let appwriteUserId;
let pendingUploadedFileId;
let pinNextArmed = false;
let pinRequestPending = false;
let pinnedMessageId = null;
let lockModeActive = false;
let maintenanceModeActive = false;
let currentName = anonymousName;
let joiningName = anonymousName;
let selectedColor = "white";
let replyToId = null;
let screenStream = null;
const peers = new Map();
const pendingCandidates = new Map();

function setConnectionStatus(state) {
  status.classList.remove("connecting", "reconnecting", "connected", "disconnected");
  status.classList.add(state);

  const labels = {
    connecting: "接続中",
    reconnecting: "再接続中",
    connected: "オンライン",
    disconnected: "オフライン",
  };

  status.textContent = labels[state];
}

function send(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(data));
  return true;
}

function connect() {
  if (socket && socket.readyState !== WebSocket.CLOSED) return;

  clearTimeout(reconnectTimer);
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  const connection = socket;

  connection.addEventListener("open", () => {
    if (socket !== connection) return;

    reconnectDelay = 1000;
    setConnectionStatus("connecting");
    joiningName = currentName;
    send({ type: "join", name: joiningName, color: selectedColor, resumeToken });
  });

  connection.addEventListener("close", () => {
    if (socket !== connection) return;

    joined = false;
    for (const id of peers.keys()) closePeer(id);
    knownPeerIds.clear();
    updateParticipantCount();

    setConnectionStatus("reconnecting");
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  connection.addEventListener("error", () => {
    if (socket === connection) setConnectionStatus("disconnected");
  });

  connection.addEventListener("message", handleSocketMessage);
}

colorSwatches.forEach((swatch) => {
  swatch.addEventListener("click", () => {
    selectedColor = swatch.dataset.color;
    colorSwatches.forEach((option) => {
      option.setAttribute("aria-pressed", String(option === swatch));
    });
    send({ type: "color", color: selectedColor });
  });
});

displayName.addEventListener("change", () => {
  const name = displayName.value.trim().slice(0, 24);
  if (!name) {
    displayName.value = currentName;
    return;
  }
  displayName.value = name;
  if (name === currentName) return;
  if (!joined) {
    currentName = name;
    localStorage.setItem(displayNameStorageKey, name);
    return;
  }
  if (send({ type: "rename", name })) {
    currentName = name;
    localStorage.setItem(displayNameStorageKey, name);
  } else displayName.value = currentName;
});

async function handleSocketMessage({ data }) {
  const packet = JSON.parse(data);
  if (packet.type === "heartbeat") {
    send({ type: "heartbeat-ack" });
  } else if (packet.type === "welcome") {
    myId = packet.id;
    isAdmin = packet.isAdmin === true;
    pinNextArmed = false;
    pinRequestPending = false;
    pinNextButton.hidden = !isAdmin;
    adminSettings.hidden = !isAdmin;
    updatePinNextButton();
    appwriteConfig = packet.appwrite;
    resumeToken = packet.resumeToken;
    sessionStorage.setItem("chat-resume-token", resumeToken);
    joined = true;
    setConnectionStatus("connected");
    updateLock(packet.lockedBy);
    updateMaintenanceMode(packet.maintenanceMode);
    packet.messages.forEach(renderMessage);
    pinnedMessageId = packet.pinnedMessageId || null;
    updatePinnedMessage();
    updateDeleteButtons();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (currentName !== joiningName) send({ type: "rename", name: currentName });
    packet.peers.forEach((id) => knownPeerIds.add(id));
    updateParticipantCount();
    if (screenStream) packet.peers.forEach(startShare);
  } else if (packet.type === "color") {
    document.querySelectorAll(`.message[data-author-id="${CSS.escape(packet.authorId)}"] .bubble`)
      .forEach((bubble) => {
        bubble.classList.remove("red", "blue", "yellow", "green", "black", "white");
        bubble.classList.add(packet.color);
      });
  } else if (packet.type === "name") {
    document.querySelectorAll(`.message[data-author-id="${CSS.escape(packet.authorId)}"] .author`)
      .forEach((author) => { author.textContent = packet.name; });
    document.querySelectorAll(`.reply-quote[data-reply-author-id="${CSS.escape(packet.authorId)}"]`)
      .forEach((quote) => { quote.textContent = `↳ ${packet.name}: ${quote.dataset.replyText}`; });
    if (packet.authorId === myId) {
      currentName = packet.name;
      displayName.value = packet.name;
      localStorage.setItem(displayNameStorageKey, packet.name);
    }
    if (pinnedMessageId) updatePinnedMessage();
  } else if (packet.type === "message") {
    if (packet.message.authorId === myId && packet.message.attachment?.fileId === pendingUploadedFileId) {
      pendingUploadedFileId = null;
    }
    if (packet.message.authorId === myId && packet.message.isPinned) {
      pinNextArmed = false;
      pinRequestPending = false;
      updatePinNextButton();
    }
    renderMessage(packet.message);
    if (packet.message.isPinned) updatePinnedMessage(packet.message.id);
  } else if (packet.type === "delete") {
    document.querySelector(`[data-message-id="${CSS.escape(packet.id)}"]`)?.remove();
    if (pinnedMessageId === packet.id) updatePinnedMessage(null);
  } else if (packet.type === "admin-enabled") {
    isAdmin = true;
    pinNextButton.hidden = false;
    adminSettings.hidden = false;
    updateMaintenanceMode(maintenanceModeActive);
    updateDeleteButtons();
  } else if (packet.type === "pin-next-state") {
    pinRequestPending = false;
    pinNextArmed = packet.enabled === true;
    updatePinNextButton();
  } else if (packet.type === "pinned-message") {
    updatePinnedMessage(packet.id);
  } else if (packet.type === "peer-joined") {
    knownPeerIds.add(packet.id);
    updateParticipantCount();
    if (screenStream) startShare(packet.id);
  } else if (packet.type === "peer-left") {
    knownPeerIds.delete(packet.id);
    updateParticipantCount();
    closePeer(packet.id);
  } else if (packet.type === "lock") {
    updateLock(packet.lockedBy);
  } else if (packet.type === "maintenance-mode") {
    updateMaintenanceMode(packet.enabled);
  } else if (packet.type === "signal") {
    try {
      await receiveSignal(packet.from, packet.signal);
    } catch {
      status.textContent = "画面共有の接続に失敗しました";
    }
  } else if (packet.type === "error") {
    if (pinRequestPending) {
      pinRequestPending = false;
      updatePinNextButton();
    }
    if (pendingUploadedFileId) {
      const fileId = pendingUploadedFileId;
      pendingUploadedFileId = null;
      void discardUploadedFile(fileId);
    }
    status.textContent = packet.message;
  }
}

connect();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !socket || socket.readyState !== WebSocket.CLOSED) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  connect();
});

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "a") {
    const code = window.prompt("管理者コード");
    if (code) send({ type: "admin-enable", code });
  }
});

function updateMaintenanceMode(enabled) {
  maintenanceModeActive = enabled === true;
  document.querySelector("#maintenance-screen").hidden = !maintenanceModeActive || isAdmin;
  adminMaintenanceToggle.querySelector("span").textContent = maintenanceModeActive
    ? "メンテナンスモードを終了"
    : "メンテナンスモードを開始";
  if (maintenanceModeActive && !isAdmin) document.querySelector("#maintenance-screen").focus();
}

function updateLock(lockedBy) {
  lockModeActive = Boolean(lockedBy);
  const isLocked = Boolean(lockedBy);
  const isOwner = lockedBy === myId;
  const lockScreen = document.querySelector("#lock-screen");
  lockScreen.hidden = !isLocked || isOwner;
  document.querySelector("#lock-indicator").hidden = !isOwner;
  adminLockToggle.querySelector("span").textContent = lockModeActive
    ? "ロックモードを終了"
    : "ロックモードを開始";
  if (!lockScreen.hidden) lockScreen.focus();
}

function renderMessage(message) {
  if (document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
  const article = document.createElement("article");
  article.className = `message${message.authorId === myId ? " own" : ""}`;
  article.dataset.messageId = message.id;
  article.dataset.authorId = message.authorId;

  const author = document.createElement("div");
  author.className = "author";
  author.textContent = message.name;
  article.append(author);
  if (message.isPinned) {
    article.classList.add("pinned");
    const badge = document.createElement("div");
    badge.className = "pin-badge";
    badge.textContent = "📌 ピン留め";
    article.append(badge);
  }

  const bubble = document.createElement("div");
  bubble.className = `bubble ${message.color}`;
  if (message.replyTo) {
    const quote = document.createElement("div");
    quote.className = "reply-quote";
    quote.dataset.replyAuthorId = message.replyTo.authorId || "";
    quote.dataset.replyText = message.replyTo.text;
    quote.textContent = `↳ ${message.replyTo.name}: ${message.replyTo.text}`;
    bubble.append(quote);
  }
  if (message.text) {
    const body = document.createElement("p");
    body.className = "message-text";
    body.textContent = message.text;
    bubble.append(body);
  }
  if (message.attachment) {
    const media = document.createElement(message.attachment.mime.startsWith("video/") ? "video" : "img");
    media.className = "attachment";
    media.src = message.attachment.url;
    media.alt = message.attachment.name;
    if (media instanceof HTMLVideoElement) {
      media.controls = true;
      media.playsInline = true;
      media.preload = "metadata";
    }
    bubble.append(media);
  }
  article.append(bubble);

  const actions = document.createElement("div");
  actions.className = "message-actions";
  const replyButton = document.createElement("button");
  replyButton.type = "button";
  replyButton.textContent = "返信";
  replyButton.addEventListener("click", () => setReply(message));
  actions.append(replyButton);
  if (message.authorId === myId || isAdmin) actions.append(createDeleteButton(message.id));
  article.append(actions);
  messagesEl.append(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function createDeleteButton(messageId) {
  const button = document.createElement("button");
  button.className = "delete-message";
  button.type = "button";
  button.textContent = "削除";
  button.addEventListener("click", () => send({ type: "delete", id: messageId }));
  return button;
}

function updateDeleteButtons() {
  messagesEl.querySelectorAll(".message").forEach((article) => {
    const actions = article.querySelector(".message-actions");
    const deleteButton = actions.querySelector(".delete-message");
    const shouldShow = isAdmin || article.dataset.authorId === myId;
    if (shouldShow && !deleteButton) {
      actions.append(createDeleteButton(article.dataset.messageId));
    } else if (!shouldShow && deleteButton) {
      deleteButton.remove();
    }
  });
}

function setReply(message) {
  replyToId = message.id;
  replyPreview.replaceChildren();
  const label = document.createElement("span");
  label.textContent = `返信先: ${message.name} — ${message.text || message.attachment?.name || ""}`;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "×";
  cancel.addEventListener("click", clearReply);
  replyPreview.append(label, cancel);
  replyPreview.hidden = false;
  textInput.focus();
}

function clearReply() {
  replyToId = null;
  replyPreview.hidden = true;
}

function updatePinNextButton() {
  pinNextButton.classList.toggle("pin-next-armed", pinNextArmed);
  pinNextButton.setAttribute("aria-pressed", String(pinNextArmed));
  pinNextButton.querySelector("span").textContent = pinNextArmed
    ? "次のメッセージのピン留めを解除"
    : "次のメッセージをピン留め";
  pinNextButton.disabled = pinRequestPending;
}

function closeAttachmentMenu() {
  attachmentMenu.hidden = true;
  attachmentMenuToggle.setAttribute("aria-expanded", "false");
}

function closeAdminSettingsMenu() {
  adminSettingsMenu.hidden = true;
  adminSettingsToggle.setAttribute("aria-expanded", "false");
}

adminSettingsToggle.addEventListener("click", () => {
  if (!isAdmin) return;
  closeAttachmentMenu();
  adminSettingsMenu.hidden = !adminSettingsMenu.hidden;
  adminSettingsToggle.setAttribute("aria-expanded", String(!adminSettingsMenu.hidden));
});

adminLockToggle.addEventListener("click", () => {
  if (isAdmin) send({ type: "lock-toggle" });
  closeAdminSettingsMenu();
});

adminMaintenanceToggle.addEventListener("click", () => {
  if (isAdmin) send({ type: "maintenance-toggle" });
  closeAdminSettingsMenu();
});

attachmentMenuToggle.addEventListener("click", () => {
  closeAdminSettingsMenu();
  attachmentMenu.hidden = !attachmentMenu.hidden;
  attachmentMenuToggle.setAttribute("aria-expanded", String(!attachmentMenu.hidden));
});

pinNextButton.addEventListener("click", () => {
  if (!isAdmin || pinRequestPending) return;
  if (send({ type: "pin-next", enabled: !pinNextArmed })) {
    pinRequestPending = true;
    pinNextButton.disabled = true;
  } else {
    status.textContent = "接続が切れているためピン留めを設定できません";
  }
  closeAttachmentMenu();
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (!event.target.closest(".attachment-menu")) closeAttachmentMenu();
  if (!event.target.closest(".settings-menu")) closeAdminSettingsMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAttachmentMenu();
    closeAdminSettingsMenu();
  }
});

fileInput.addEventListener("change", () => {
  updateFilePreview(fileInput.files[0]);
  closeAttachmentMenu();
});
fileInput.addEventListener("click", closeAttachmentMenu);
removeFileButton.addEventListener("click", clearSelectedFile);

function updateFilePreview(file) {
  fileNameText.textContent = file?.name || "";
  fileName.hidden = !file;
}

function clearSelectedFile() {
  fileInput.value = "";
  updateFilePreview(null);
}

function updatePinnedMessage(messageId = pinnedMessageId) {
  pinnedMessageId = messageId;
  messagesEl.querySelectorAll(".message.pinned").forEach((article) => {
    article.classList.remove("pinned");
    article.querySelector(".pin-badge")?.remove();
  });
  pinnedMessage.replaceChildren();
  const article = pinnedMessageId
    ? messagesEl.querySelector(`[data-message-id="${CSS.escape(pinnedMessageId)}"]`)
    : null;
  if (!article) {
    pinnedMessage.hidden = true;
    return;
  }
  article.classList.add("pinned");
  const badge = document.createElement("div");
  badge.className = "pin-badge";
  badge.textContent = "📌 ピン留め";
  article.prepend(badge);
  const author = article.querySelector(".author")?.textContent || "";
  const content = article.querySelector(".message-text")?.textContent ||
    article.querySelector(".attachment")?.getAttribute("alt") || "添付ファイル";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = `📌 ${author}: ${content}`;
  button.title = "ピン留めされたメッセージへ移動";
  button.addEventListener("click", () => article.scrollIntoView({ behavior: "smooth", block: "center" }));
  pinnedMessage.append(button);
  pinnedMessage.hidden = false;
}

const maxUploadSize = 330 * 1024 * 1024;
const uploadChunkSize = 5 * 1024 * 1024;

async function appwriteJson(path, options = {}) {
  const response = await fetch(`${appwriteConfig.endpoint}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "X-Appwrite-Project": appwriteConfig.projectId,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    let detail = `Appwrite request failed (${response.status})`;
    try {
      const error = await response.json();
      detail = error.message || detail;
    } catch {}
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function ensureAppwriteSession() {
  if (!appwriteSessionPromise) {
    appwriteSessionPromise = (async () => {
      if (!appwriteConfig) throw new Error("Appwriteの接続設定を取得できませんでした。");
      let session;
      try {
        session = await appwriteJson("/account/sessions/current");
      } catch (error) {
        if (error.status !== 401) throw error;
        session = await appwriteJson("/account/sessions/anonymous", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      }
      appwriteUserId = session.userId;
    })().catch((error) => {
      appwriteSessionPromise = null;
      throw error;
    });
  }
  await appwriteSessionPromise;
}

async function getAppwriteJwt() {
  await ensureAppwriteSession();
  const result = await appwriteJson("/account/jwt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return result.jwt;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("画像を圧縮できませんでした。"));
    }, type, quality);
  });
}

async function compressImage(file) {
  if (["image/gif", "image/svg+xml", "image/apng"].includes(file.type)) return file;
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("画像圧縮用Canvasを作成できませんでした。");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, "image/webp", 0.82);
    const baseName = file.name.replace(/\.[^.]+$/, "");
    const extension = blob.type === "image/webp" ? "webp" : "png";
    return new File([blob], `${baseName}.${extension}`, { type: blob.type });
  } finally {
    bitmap.close();
  }
}

async function compressVideo(file) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream || !window.AudioContext) {
    throw new Error("このブラウザーは動画圧縮に対応していません。");
  }
  const sourceUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.src = sourceUrl;
  let audioContext;
  let stream;
  try {
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("動画を読み込めませんでした。")), { once: true });
    });
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("動画圧縮用Canvasを作成できませんでした。");

    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    const source = audioContext.createMediaElementSource(video);
    source.connect(destination);
    await audioContext.resume();
    stream = canvas.captureStream(30);
    destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));

    const mimeType = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      throw new Error("このブラウザーの動画形式には対応していません。");
    }
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 1_250_000,
      audioBitsPerSecond: 128_000,
    });
    const chunks = [];
    const result = new Promise((resolve, reject) => {
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener("error", () => reject(new Error("動画の圧縮に失敗しました。")), { once: true });
      recorder.addEventListener("stop", () => {
        if (!chunks.length) {
          reject(new Error("圧縮後の動画を作成できませんでした。"));
          return;
        }
        resolve(new Blob(chunks, { type: recorder.mimeType || mimeType }));
      }, { once: true });
    });
    result.catch(() => {});

    let frame;
    const drawFrame = () => {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (!video.ended && recorder.state === "recording") frame = requestAnimationFrame(drawFrame);
    };
    const ended = new Promise((resolve, reject) => {
      video.addEventListener("ended", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("動画の再生中にエラーが発生しました。")), { once: true });
    });
    recorder.start(1000);
    try {
      await video.play();
      drawFrame();
      await ended;
    } finally {
      cancelAnimationFrame(frame);
      if (recorder.state === "recording") recorder.stop();
    }
    const blob = await result;
    if (blob.size > maxUploadSize) throw new Error("圧縮後の動画が330MBを超えています。");
    const extension = blob.type.includes("mp4") ? "mp4" : "webm";
    const baseName = file.name.replace(/\.[^.]+$/, "");
    return new File([blob], `${baseName}.${extension}`, { type: blob.type });
  } finally {
    URL.revokeObjectURL(sourceUrl);
    stream?.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== "closed") await audioContext.close();
  }
}

async function uploadToAppwrite(file) {
  await ensureAppwriteSession();
  const fileId = crypto.randomUUID().replaceAll("-", "");
  const totalChunks = Math.ceil(file.size / uploadChunkSize);
  let uploadId;
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * uploadChunkSize;
      const end = Math.min(start + uploadChunkSize, file.size);
      const form = new FormData();
      form.append("fileId", fileId);
      form.append("permissions[]", 'read("any")');
      form.append("permissions[]", `delete("user:${appwriteUserId}")`);
      form.append("file", file.slice(start, end, file.type), file.name);
      const headers = { "X-Appwrite-JWT": await getAppwriteJwt() };
      if (totalChunks > 1) {
        headers["Content-Range"] = `bytes ${start}-${end - 1}/${file.size}`;
        if (uploadId) headers["X-Appwrite-ID"] = uploadId;
      }
      const response = await fetch(
        `${appwriteConfig.endpoint}/storage/buckets/${encodeURIComponent(appwriteConfig.bucketId)}/files`,
        {
          method: "POST",
          headers: {
            "X-Appwrite-Project": appwriteConfig.projectId,
            ...headers,
          },
          credentials: "include",
          body: form,
        },
      );
      if (!response.ok) {
        let detail = `Appwriteへのアップロードに失敗しました (${response.status})`;
        try {
          const error = await response.json();
          detail = error.message || detail;
        } catch {}
        throw new Error(detail);
      }
      const result = await response.json();
      uploadId = result.$id || uploadId;
      status.textContent = `アップロード中 ${Math.round((end / file.size) * 100)}%`;
    }
  } catch (error) {
    await discardUploadedFile(uploadId || fileId);
    throw error;
  }
  return { fileId: uploadId || fileId, fileName: file.name, fileMime: file.type };
}

async function discardUploadedFile(fileId) {
  try {
    const response = await fetch(
      `${appwriteConfig.endpoint}/storage/buckets/${encodeURIComponent(appwriteConfig.bucketId)}/files/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
        headers: {
          "X-Appwrite-Project": appwriteConfig.projectId,
          "X-Appwrite-JWT": await getAppwriteJwt(),
        },
        credentials: "include",
      },
    );
    if (!response.ok && response.status !== 404) {
      console.error(`Could not remove unattached Appwrite file (${response.status}).`);
    }
  } catch (error) {
    console.error("Could not remove unattached Appwrite file:", error);
  }
}

document.querySelector("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  const text = textInput.value.trim();
  if (!text && !file) return;
  if (file && (!file.type.startsWith("image/") && !file.type.startsWith("video/"))) {
    alert("画像または動画を選択してください。");
    return;
  }
  if (file && file.size > maxUploadSize) {
    alert("画像・動画は330MB以下にしてください。");
    return;
  }

  let uploadedFile;
  try {
    if (file) {
      status.textContent = file.type.startsWith("video/") ? "動画を720pに圧縮中..." : "画像を圧縮中...";
      const preparedFile = file.type.startsWith("video/")
        ? await compressVideo(file)
        : await compressImage(file);
      if (preparedFile.size > maxUploadSize) {
        throw new Error("圧縮後のファイルが330MBを超えています。");
      }
      uploadedFile = await uploadToAppwrite(preparedFile);
    }
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  if (uploadedFile) pendingUploadedFileId = uploadedFile.fileId;
  if (!send({ type: "message", text, ...uploadedFile, replyTo: replyToId })) {
    if (uploadedFile) await discardUploadedFile(uploadedFile.fileId);
    pendingUploadedFileId = null;
    status.textContent = "接続が切れているため送信できません";
    return;
  }
  textInput.value = "";
  clearSelectedFile();
  clearReply();
  status.textContent = "接続済み";
});

shareButton.addEventListener("click", async () => {
  if (screenStream) {
    stopSharing();
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenStream.getVideoTracks()[0].addEventListener("ended", stopSharing, { once: true });
    shareButton.textContent = "共有を停止";
    for (const [id] of peers) closePeer(id);
    // Peer connections are created from the sharer so each connection negotiates one screen stream.
    document.querySelectorAll("[data-screen-id]").forEach((video) => video.remove());
    sendShareToPeers();
  } catch (error) {
    status.textContent = error.name === "NotAllowedError" ? "画面共有がキャンセルされました" : "画面共有を開始できません";
  }
});

function stopSharing() {
  const stream = screenStream;
  screenStream = null;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  shareButton.textContent = "画面共有";
  for (const [id] of peers) closePeer(id);
}

function sendShareToPeers() {
  // Peer IDs are learned through the welcome packet and peer-joined events.
  knownPeerIds.forEach(startShare);
}

const knownPeerIds = new Set();
function updateParticipantCount() {
  participantCount.textContent = `参加人数: ${joined ? knownPeerIds.size + 1 : "--"}`;
}

function startShare(id) {
  knownPeerIds.add(id);
  if (!screenStream || peers.has(id)) return;
  const pc = createPeer(id);
  screenStream.getTracks().forEach((track) => pc.addTrack(track, screenStream));
  pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
    send({ type: "signal", to: id, signal: { description: pc.localDescription } });
  }).catch(() => status.textContent = "画面共有の接続に失敗しました");
}

function createPeer(id) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  peers.set(id, pc);
  pendingCandidates.set(id, []);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "signal", to: id, signal: { candidate } });
  };
  pc.ontrack = ({ streams }) => showRemoteScreen(id, streams[0]);
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) closePeer(id);
  };
  return pc;
}

async function receiveSignal(id, signal) {
  let pc = peers.get(id);
  if (signal.description?.type === "offer") {
    if (pc) closePeer(id);
    pc = createPeer(id);
    await pc.setRemoteDescription(signal.description);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: "signal", to: id, signal: { description: pc.localDescription } });
    for (const candidate of pendingCandidates.get(id) || []) await pc.addIceCandidate(candidate);
    pendingCandidates.set(id, []);
  } else if (signal.description?.type === "answer" && pc) {
    await pc.setRemoteDescription(signal.description);
    for (const candidate of pendingCandidates.get(id) || []) await pc.addIceCandidate(candidate);
    pendingCandidates.set(id, []);
  } else if (signal.candidate) {
    if (pc?.remoteDescription) await pc.addIceCandidate(signal.candidate);
    else {
      if (!pendingCandidates.has(id)) pendingCandidates.set(id, []);
      pendingCandidates.get(id).push(signal.candidate);
    }
  }
}

function showRemoteScreen(id, stream) {
  let video = document.querySelector(`[data-screen-id="${CSS.escape(id)}"]`);
  if (!video) {
    video = document.createElement("video");
    video.dataset.screenId = id;
    video.autoplay = true;
    video.playsInline = true;
    document.querySelector("#screens").append(video);
  }
  video.srcObject = stream;
}

function closePeer(id) {
  peers.get(id)?.close();
  peers.delete(id);
  pendingCandidates.delete(id);
  document.querySelector(`[data-screen-id="${CSS.escape(id)}"]`)?.remove();
}
