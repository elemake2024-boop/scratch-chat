const status = document.querySelector("#status");
const messagesEl = document.querySelector("#messages");
const textInput = document.querySelector("#text");
const fileInput = document.querySelector("#file");
const fileName = document.querySelector("#file-name");
const replyPreview = document.querySelector("#reply-preview");
const shareButton = document.querySelector("#share");
const colorInput = document.querySelector("#color");
const displayName = document.querySelector("#display-name");

const nameParts = ["あお", "ゆき", "はる", "そら", "もも", "りん"];
const anonymousName = `匿名${nameParts[Math.floor(Math.random() * nameParts.length)]}#${Math.floor(1000 + Math.random() * 9000)}`;
displayName.value = anonymousName;

let myId;
let joined = false;
let isAdmin = false;
let socket;
let reconnectTimer;
let reconnectDelay = 1000;
let resumeToken = sessionStorage.getItem("chat-resume-token");
let currentName = anonymousName;
let joiningName = anonymousName;
let replyToId = null;
let screenStream = null;
const peers = new Map();
const pendingCandidates = new Map();

function setConnectionStatus(state) {
  status.classList.remove("connecting", "reconnecting", "connected", "disconnected");
  status.classList.add(state);
  status.textContent = {
    connecting: "接続中",
    reconnecting: "再接続中",
    connected: "接続済み",
    disconnected: "接続不可",
  }[state];
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
    send({ type: "join", name: joiningName, color: colorInput.value, resumeToken });
  });
  connection.addEventListener("close", () => {
    if (socket !== connection) return;
    joined = false;
    for (const id of peers.keys()) closePeer(id);
    knownPeerIds.clear();
    setConnectionStatus("reconnecting");
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });
  connection.addEventListener("error", () => {
    if (socket === connection) setConnectionStatus("disconnected");
  });
  connection.addEventListener("message", handleSocketMessage);
}

colorInput.addEventListener("change", () => {
  send({ type: "color", color: colorInput.value });
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
    return;
  }
  if (send({ type: "rename", name })) currentName = name;
  else displayName.value = currentName;
});

async function handleSocketMessage({ data }) {
  const packet = JSON.parse(data);
  if (packet.type === "heartbeat") {
    send({ type: "heartbeat-ack" });
  } else if (packet.type === "welcome") {
    myId = packet.id;
    isAdmin = packet.isAdmin === true;
    resumeToken = packet.resumeToken;
    sessionStorage.setItem("chat-resume-token", resumeToken);
    joined = true;
    setConnectionStatus("connected");
    updateLock(packet.lockedBy);
    packet.messages.forEach(renderMessage);
    updateDeleteButtons();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (currentName !== joiningName) send({ type: "rename", name: currentName });
    packet.peers.forEach((id) => knownPeerIds.add(id));
    if (screenStream) packet.peers.forEach(startShare);
  } else if (packet.type === "color") {
    document.querySelectorAll(`.message[data-author-id="${CSS.escape(packet.authorId)}"] .bubble`)
      .forEach((bubble) => {
        bubble.classList.remove("red", "blue", "yellow", "green", "white");
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
    }
  } else if (packet.type === "message") {
    renderMessage(packet.message);
  } else if (packet.type === "delete") {
    document.querySelector(`[data-message-id="${CSS.escape(packet.id)}"]`)?.remove();
  } else if (packet.type === "admin-enabled") {
    isAdmin = true;
    updateDeleteButtons();
  } else if (packet.type === "peer-joined") {
    knownPeerIds.add(packet.id);
    if (screenStream) startShare(packet.id);
  } else if (packet.type === "peer-left") {
    knownPeerIds.delete(packet.id);
    closePeer(packet.id);
  } else if (packet.type === "lock") {
    updateLock(packet.lockedBy);
  } else if (packet.type === "signal") {
    try {
      await receiveSignal(packet.from, packet.signal);
    } catch {
      status.textContent = "画面共有の接続に失敗しました";
    }
  } else if (packet.type === "error") {
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

let keySequence = "";
document.addEventListener("keydown", (event) => {
  if (event.key.length !== 1 || !/^\d$/.test(event.key)) {
    keySequence = "";
    return;
  }
  const target = event.target;
  if (target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
    keySequence = "";
    return;
  }
  keySequence = `${keySequence}${event.key}`.slice(-4);
  if (keySequence === "6780") {
    send({ type: "lock-toggle" });
    keySequence = "";
  } else if (keySequence === "888") {
    send({ type: "admin-enable", code: "888" });
    keySequence = "";
  }
});

function updateLock(lockedBy) {
  const isLocked = Boolean(lockedBy);
  const isOwner = lockedBy === myId;
  const lockScreen = document.querySelector("#lock-screen");
  lockScreen.hidden = !isLocked || isOwner;
  document.querySelector("#lock-indicator").hidden = !isOwner;
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
    media.src = message.attachment.data;
    media.alt = message.attachment.name;
    if (media instanceof HTMLVideoElement) {
      media.controls = true;
      media.playsInline = true;
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

fileInput.addEventListener("change", () => {
  fileName.textContent = fileInput.files[0]?.name || "";
});

document.querySelector("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  const text = textInput.value.trim();
  if (!text && !file) return;
  if (file && (!file.type.startsWith("image/") && !file.type.startsWith("video/"))) {
    alert("画像または動画を選択してください。");
    return;
  }
  if (file && file.size > 8 * 1024 * 1024) {
    alert("画像・動画は8MB以下にしてください。");
    return;
  }

  let attachment;
  try {
    if (file) {
      attachment = {
        data: await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("ファイルを読み込めませんでした。"));
          reader.readAsDataURL(file);
        }),
        name: file.name,
        mime: file.type,
      };
    }
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  if (!send({ type: "message", text, attachment, replyTo: replyToId })) {
    status.textContent = "接続が切れているため送信できません";
    return;
  }
  textInput.value = "";
  fileInput.value = "";
  fileName.textContent = "";
  clearReply();
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
