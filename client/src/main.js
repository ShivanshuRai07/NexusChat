import './style.css';
import { io } from 'socket.io-client';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? `http://${window.location.hostname}:3000` : "");
const connStatus = document.getElementById('conn-status');

if (!SERVER_URL && window.location.protocol.startsWith('http')) {
   console.error("CRITICAL: VITE_SERVER_URL is not defined in this production build. Pointing to null/localhost will fail.");
}

// Global Connection Pulse
if (SERVER_URL) {
  initSocketConnection();
}

let socket = null;
let currentUsername = localStorage.getItem('nexus-username') || "";
let currentNetworkCode = localStorage.getItem('nexus-network') || "";
let savedNetworks = JSON.parse(localStorage.getItem('nexus-saved-networks')) || [];
let autoJoinNetCode = new URLSearchParams(window.location.search).get('network');

let activePeersList = []; // Array of { id, username }
let currentTargetSocketId = null;
let currentTargetUsername = null;

// Memory mapping: "NetworkCode_Username" -> { unread: 0, history: [] }
let conversationMemory = new Map(); 

// DOM Elements
const entryContainer = document.getElementById('entry-container');
const entryForm = document.getElementById('entry-form');
const usernameInput = document.getElementById('username-input');
const networkCodeInput = document.getElementById('network-code-input');
const joinNetworkBtn = document.getElementById('join-network-btn');
const openCreateModalBtn = document.getElementById('open-create-modal-btn');

const createModal = document.getElementById('create-modal');
const modalNetworkName = document.getElementById('modal-network-name');
const modalNetworkCode = document.getElementById('modal-network-code');
const modalNetworkLink = document.getElementById('modal-network-link');
const modalCopyCodeBtn = document.getElementById('modal-copy-code-btn');
const modalCopyLinkBtn = document.getElementById('modal-copy-link-btn');
const finalizeCreateBtn = document.getElementById('finalize-create-btn');
const cancelCreateBtn = document.getElementById('cancel-create-btn');

const chatContainer = document.getElementById('chat-container');
const sidebarView = document.getElementById('sidebar-view');
const chatView = document.getElementById('chat-view');
const mobileBackBtn = document.getElementById('mobile-back-btn');
const roomsList = document.getElementById('rooms-list');
const networkSwitcher = document.getElementById('network-switcher');

const emptyState = document.getElementById('empty-state');
const activeChatUI = document.getElementById('active-chat-ui');
const currentPeerName = document.getElementById('current-peer-name');
const messagesList = document.getElementById('messages-list');
const typingIndicator = document.getElementById('typing-indicator');

const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const attachmentTriggerBtn = document.getElementById('attachment-trigger-btn');
const mediaInput = document.getElementById('media-input');
const attachmentPreview = document.getElementById('attachment-preview');

let typingTimeout = null;
let pendingAttachments = [];

// --- INITIALIZATION ---
if (autoJoinNetCode) {
   networkCodeInput.value = autoJoinNetCode.toUpperCase();
}
if (currentUsername) usernameInput.value = currentUsername;

loadMemory();

// --- ENTRY & VPN AUTHENTICATION FLOW ---
entryForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const user = usernameInput.value.trim();
  const netCode = networkCodeInput.value.trim().toUpperCase();
  if(!user || !netCode) return showAlert('Missing Fields', 'Please provide an Alias and a Network Passkey to connect.');
  
  currentUsername = user;
  currentNetworkCode = netCode;
  localStorage.setItem('nexus-username', currentUsername);
  localStorage.setItem('nexus-network', currentNetworkCode);
  
  if (!socket) initSocketConnection();
  socket.emit('network:join', { username: currentUsername, networkCode: currentNetworkCode });
});

openCreateModalBtn.addEventListener('click', () => {
   const newCode = Math.random().toString(36).substring(2, 10).toUpperCase();
   modalNetworkCode.value = newCode;
   modalNetworkLink.value = `${window.location.origin}/?network=${newCode}`;
   modalNetworkName.value = "";
   createModal.classList.remove('hidden');
});

cancelCreateBtn.addEventListener('click', () => {
   createModal.classList.add('hidden');
});

modalCopyCodeBtn.addEventListener('click', () => {
   modalNetworkCode.select();
   try{navigator.clipboard.writeText(modalNetworkCode.value);}catch(e){}
   modalCopyCodeBtn.textContent = "Copied!";
   setTimeout(()=> modalCopyCodeBtn.textContent = "Copy Code", 2000);
});

modalCopyLinkBtn.addEventListener('click', () => {
   modalNetworkLink.select();
   try{navigator.clipboard.writeText(modalNetworkLink.value);}catch(e){}
   modalCopyLinkBtn.textContent = "Copied!";
   setTimeout(()=> modalCopyLinkBtn.textContent = "Copy Link", 2000);
});

finalizeCreateBtn.addEventListener('click', () => {
  const user = usernameInput.value.trim();
  const netName = modalNetworkName.value.trim();
  const netCode = modalNetworkCode.value;
  
  if(!user || !netName) return showAlert('Missing Fields', 'Please ensure you have typed your Alias on the main page, and a Network Name here.');
  
  currentUsername = user;
  currentNetworkCode = netCode;
  
  localStorage.setItem('nexus-username', currentUsername);
  localStorage.setItem('nexus-network', currentNetworkCode);
  
  if (!socket) initSocketConnection();
  socket.emit('network:create', { username: currentUsername, networkCode: currentNetworkCode, networkName: netName });
  
  createModal.classList.add('hidden');
});

// --- SIDEBAR & MOBILE NAVIGATION ---
mobileBackBtn.addEventListener('click', () => {
  chatView.classList.add('mobile-hidden');
  sidebarView.classList.remove('mobile-hidden');
  currentTargetSocketId = null;
  currentTargetUsername = null;
  renderSidebar();
});

function getMemoryKey(peerUsername) {
  return `${currentNetworkCode}_${peerUsername}`;
}

function getOrInitMemory(peerUsername) {
   const key = getMemoryKey(peerUsername);
   if (!conversationMemory.has(key)) {
      conversationMemory.set(key, { unread: 0, history: [] });
   }
   return conversationMemory.get(key);
}

function saveAndRenderNetworks(code, name) {
   if (!savedNetworks.find(n => n.code === code)) {
       savedNetworks.push({code, name});
       localStorage.setItem('nexus-saved-networks', JSON.stringify(savedNetworks));
   }
   
   networkSwitcher.innerHTML = `<option value="">-- Switch Network --</option>`;
   savedNetworks.forEach(net => {
      const opt = document.createElement('option');
      opt.value = net.code;
      opt.textContent = `${net.name} (${net.code})`;
      if (net.code === currentNetworkCode) opt.selected = true;
      networkSwitcher.appendChild(opt);
   });
}

networkSwitcher.addEventListener('change', (e) => {
   const newCode = e.target.value;
   if (newCode && socket) {
      const net = savedNetworks.find(n => n.code === newCode);
      if(!net) return;
      
      currentNetworkCode = net.code;
      localStorage.setItem('nexus-network', currentNetworkCode);
      
      currentTargetSocketId = null;
      currentTargetUsername = null;
      activePeersList = [];
      
      chatView.classList.add('mobile-hidden');
      sidebarView.classList.remove('mobile-hidden');
      activeChatUI.classList.add('hidden');
      emptyState.classList.remove('hidden');
      
      socket.emit('network:join', { username: currentUsername, networkCode: currentNetworkCode });
   }
});

function renderSidebar() {
  roomsList.innerHTML = '';
  const peersExcludingSelf = activePeersList.filter(p => p.id !== socket?.id);

  if (peersExcludingSelf.length === 0) {
     roomsList.innerHTML = `<li style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">Waiting for other peers to connect to this network...</li>`;
     return;
  }

  peersExcludingSelf.forEach((peer) => {
    const mem = getOrInitMemory(peer.username);
    const li = document.createElement('li');
    li.className = `room-item ${currentTargetSocketId === peer.id ? 'active' : ''}`;
    
    li.innerHTML = `
      <div class="room-avatar" style="background:#005c4b;">${peer.username.substring(0, 2).toUpperCase()}</div>
      <div class="room-info">
        <div class="room-name">${peer.username}</div>
        <div style="font-size: 0.8rem; color: var(--text-muted);">
          ${mem.unread > 0 ? `<span style="color: var(--success); font-weight: bold;">${mem.unread} new message(s)</span>` : '<span style="color:#00a884;">Active IP Target</span>'}
        </div>
      </div>
    `;
    
    li.addEventListener('click', () => selectPeer(peer.id, peer.username));
    roomsList.appendChild(li);
  });
}

function selectPeer(socketId, username) {
  currentTargetSocketId = socketId;
  currentTargetUsername = username;
  
  const mem = getOrInitMemory(username);
  mem.unread = 0;
  saveMemory();
  
  renderSidebar();

  sidebarView.classList.add('mobile-hidden');
  chatView.classList.remove('mobile-hidden');

  emptyState.classList.add('hidden');
  activeChatUI.classList.remove('hidden');
  currentPeerName.textContent = username;
  
  messageInput.disabled = false;
  sendBtn.disabled = false;
  attachmentTriggerBtn.disabled = false;
  
  renderActiveChatHistory();
}

// --- SOCKET NETWORKING ---
function initSocketConnection() {
  socket = io(SERVER_URL);

  socket.on('connect_error', (err) => {
    console.error("Connection Error:", err);
    if (connStatus) {
       connStatus.style.background = "#ef4444";
       connStatus.style.boxShadow = "0 0 12px #ef4444";
       connStatus.title = `Access Denied: ${err.message}`;
    }
  });

  socket.on('connect', () => {
    console.log(`[+] WebSockets connected to inter-device TCP relay.`);
    if (connStatus) {
       connStatus.style.background = "#22c55e"; // Green
       connStatus.style.boxShadow = "0 0 12px #22c55e";
       connStatus.title = "Secure Link Active";
    }
  });
  
  socket.on('network:success', (data) => {
    saveAndRenderNetworks(data.networkCode, data.networkName);
    
    entryContainer.style.display = 'none';
    chatContainer.classList.remove('hidden');
    
    if (autoJoinNetCode) {
       window.history.replaceState({}, document.title, window.location.pathname);
       autoJoinNetCode = null;
    }
  });

  socket.on('network:error', (msg) => {
    showAlert('Access Denied', msg);
    if (autoJoinNetCode) autoJoinNetCode = null;
  });

  socket.on('network:peers', (peers) => {
    activePeersList = peers;
    
    const isTargetStillOnline = activePeersList.find(p => p.id === currentTargetSocketId);
    if (!isTargetStillOnline && currentTargetSocketId) {
       showAlert("Peer Dropped", "This peer has disconnected from the network.");
       currentTargetSocketId = null; 
       messageInput.disabled = true;
       sendBtn.disabled = true;
       attachmentTriggerBtn.disabled = true;
    }

    renderSidebar();
  });

  socket.on('message:receive', (packet) => {
    const { senderId, senderName, text, attachments, timestamp } = packet;
    
    const isSelfPack = senderId === socket.id;
    const historyTargetUser = isSelfPack ? currentTargetUsername : senderName;
    
    if (!historyTargetUser) return;

    const mem = getOrInitMemory(historyTargetUser);
    mem.history.push({
       isSelf: isSelfPack,
       text,
       attachments: attachments || [],
       timestamp,
       senderName
    });

    if (currentTargetUsername === historyTargetUser) {
       appendMessage(mem.history[mem.history.length - 1]);
       scrollToBottom();
    } else if (!isSelfPack) {
       mem.unread++;
       renderSidebar();
    }
    
    saveMemory();
  });

  socket.on('user:typing', (typistId) => {
    if (currentTargetSocketId === typistId) {
      typingIndicator.classList.remove('hidden');
    }
  });

  socket.on('user:stopTyping', (typistId) => {
    if (currentTargetSocketId === typistId) {
      typingIndicator.classList.add('hidden');
    }
  });
}

// --- MEDIA ATTACHMENTS ---
attachmentTriggerBtn.addEventListener('click', () => mediaInput.click());

mediaInput.addEventListener('change', () => {
  const files = Array.from(mediaInput.files);
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingAttachments.push({ fileBase64: e.target.result, fileName: file.name, fileType: file.type });
      renderAttachmentPreview();
    };
    reader.readAsDataURL(file);
  });
});

function renderAttachmentPreview() {
  attachmentPreview.innerHTML = '';
  if (pendingAttachments.length === 0) {
     attachmentPreview.classList.add('hidden');
     return;
  }
  attachmentPreview.classList.remove('hidden');
  
  pendingAttachments.forEach((att, index) => {
     const wrap = document.createElement('div');
     wrap.style.position = 'relative';
     wrap.style.width = '60px';
     wrap.style.height = '60px';
     wrap.style.border = '1px solid var(--border-color)';
     wrap.style.borderRadius = '6px';
     wrap.style.overflow = 'hidden';
     
     let inner = '';
     if (att.fileType.startsWith('image/')) inner = `<img src="${att.fileBase64}" style="width:100%; height:100%; object-fit:cover;" />`;
     else if (att.fileType.startsWith('video/')) inner = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;font-size:0.8rem;">🎥</div>`;
     else inner = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#202c33;color:#fff;font-size:0.6rem;overflow:hidden;text-overflow:ellipsis;padding:2px;text-align:center;">📄 ${att.fileName}</div>`;
     
     wrap.innerHTML = `${inner}
       <button type="button" class="remove-att-btn" data-idx="${index}" style="position:absolute;top:0;right:0;background:rgba(255,0,0,0.8);border:none;color:white;width:18px;height:18px;font-size:12px;cursor:pointer;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;">&times;</button>`;
     attachmentPreview.appendChild(wrap);
  });
  
  document.querySelectorAll('.remove-att-btn').forEach(btn => {
     btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.getAttribute('data-idx'));
        pendingAttachments.splice(idx, 1);
        renderAttachmentPreview();
     });
  });
  
  messageInput.focus();
}

function clearAttachment() {
  pendingAttachments = [];
  mediaInput.value = '';
  renderAttachmentPreview();
}

// --- MESSAGE SENDING ---
messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  
  if ((text || pendingAttachments.length > 0) && socket && currentTargetSocketId) {
    socket.emit('message:send', { 
      targetSocketId: currentTargetSocketId, 
      text: text,
      attachments: [...pendingAttachments] 
    });
    messageInput.value = '';
    clearAttachment();
    socket.emit('user:stopTyping', currentTargetSocketId);
  }
});

messageInput.addEventListener('input', () => {
  if (!socket || !currentTargetSocketId) return;
  socket.emit('user:typing', currentTargetSocketId);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('user:stopTyping', currentTargetSocketId), 1000);
});

// --- RENDER HELPERS ---
function renderActiveChatHistory() {
  messagesList.innerHTML = '';
  if (currentTargetUsername) {
    const mem = getOrInitMemory(currentTargetUsername);
    mem.history.forEach(msg => appendMessage(msg));
  }
  requestAnimationFrame(scrollToBottom);
}

function appendMessage(msg) {
  const li = document.createElement('li');
  
  if (msg.type === 'system') {
    li.className = 'message system';
    li.innerHTML = escapeHTML(msg.text);
  } else {
    li.className = `message ${msg.isSelf ? 'self' : 'other'}`;
    
    const timeInfo = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let mediaHTML = '';
    
    // Catch legacy un-migrated image payloads from prior memory blocks (like the samurai cache)
    if (msg.mediaBase64 && (!msg.attachments || msg.attachments.length === 0)) {
       if (msg.mediaBase64.startsWith('data:video/')) {
           mediaHTML = `<div class="message-attachments" style="display:flex; flex-wrap:wrap; gap:5px; margin-bottom: 5px;"><video src="${msg.mediaBase64}" controls style="max-width:250px; max-height:250px; border-radius:6px;"></video></div>`;
       } else {
           mediaHTML = `<div class="message-attachments" style="display:flex; flex-wrap:wrap; gap:5px; margin-bottom: 5px;"><img src="${msg.mediaBase64}" style="max-width:250px; max-height:250px; object-fit:cover; border-radius:6px;" loading="lazy"/></div>`;
       }
    } else if (msg.attachments && msg.attachments.length > 0) {
      mediaHTML = `<div class="message-attachments" style="display:flex; flex-wrap:wrap; gap:5px; margin-bottom: 5px;">`;
      msg.attachments.forEach(att => {
        if (att.fileType === 'system') {
           mediaHTML += `<div style="font-size: 0.8rem; font-style: italic; color: var(--text-muted); width:100%; border:1px solid rgba(255,255,255,0.1); padding: 5px; border-radius: 4px;">[Media/Document Ephemeral Attachment Cleared]</div>`;
        } else if (att.fileType.startsWith('image/')) {
           mediaHTML += `<img src="${att.fileBase64}" style="max-width:250px; max-height:250px; object-fit:cover; border-radius:6px;" loading="lazy"/>`;
        } else if (att.fileType.startsWith('video/')) {
           mediaHTML += `<video src="${att.fileBase64}" controls style="max-width:250px; max-height:250px; border-radius:6px;"></video>`;
        } else {
           mediaHTML += `
             <a href="${att.fileBase64}" download="${att.fileName}" style="display:flex; align-items:center; gap:8px; padding:10px; background:rgba(0,0,0,0.25); border-radius:6px; text-decoration:none; color:inherit; min-width:200px; max-width: 250px;">
                <svg width="24" height="24" fill="none" stroke="var(--accent-color)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                <span style="font-size:0.85rem; word-break:break-all; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(att.fileName)}</span>
             </a>`;
        }
      });
      mediaHTML += `</div>`;
    }
    
    li.innerHTML = `
      ${!msg.isSelf ? `<div class="message-meta">${escapeHTML(msg.senderName)}</div>` : ''}
      <div class="message-content">
        ${mediaHTML}
        ${escapeHTML(msg.text)}
        <div class="message-time">${timeInfo} <svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" height="12" width="12"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
      </div>
    `;
  }
  messagesList.appendChild(li);
}

function scrollToBottom() {
  messagesList.scrollTop = messagesList.scrollHeight;
}

function escapeHTML(str) {
  if (!str) return "";
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- LOCAL DEVICE MEMORY ---
function saveMemory() {
  const backupData = Array.from(conversationMemory.entries()).map(([key, data]) => {
     return [key, {
        unread: data.unread,
        history: data.history.map(msg => ({
           isSelf: msg.isSelf,
           text: msg.text,
           timestamp: msg.timestamp,
           senderName: msg.senderName,
           attachments: msg.attachments || [],
           mediaBase64: msg.mediaBase64 || null
        }))
     }];
  });
  
  try {
     localStorage.setItem('nexus-subnet-memory', JSON.stringify(backupData));
  } catch (err) {
     if (err.name === 'QuotaExceededError') {
         showAlert("Storage Limit Reached", "Your browser's memory capacity (5MB) is full. Older media may need to be deleted to save new data, or clearing cache is required.");
     } else {
         console.error("Memory saving error:", err);
     }
  }
}

function loadMemory() {
  const dataString = localStorage.getItem('nexus-subnet-memory');
  if (dataString) {
    try {
      const parsed = JSON.parse(dataString);
      conversationMemory = new Map(parsed);
    } catch(e) {}
  }
}

// --- LIGHTBOX & DOWNLOADING ---
const lightbox = document.getElementById('image-lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxDownload = document.getElementById('lightbox-download');
const lightboxClose = document.getElementById('lightbox-close');

if (messagesList) {
  messagesList.addEventListener('click', (e) => {
     if (e.target.tagName === 'IMG' && e.target.closest('.message-attachments, .message-media')) {
         lightboxImg.src = e.target.src;
         lightboxDownload.href = e.target.src;
         lightboxDownload.download = "Nexus_Media_" + Date.now() + ".jpg";
         lightbox.classList.remove('hidden');
     }
  });
}

if (lightboxClose) lightboxClose.addEventListener('click', () => lightbox.classList.add('hidden'));
if (lightbox) lightbox.addEventListener('click', (e) => {
   if (e.target === lightbox) lightbox.classList.add('hidden');
});

// --- SESSION MANAGEMENT & TEARDOWN ---
const logoutBtn = document.getElementById('logout-btn');
const leaveNetworkBtn = document.getElementById('leave-network-btn');
const sidebarAlias = document.getElementById('sidebar-alias');

if (sidebarAlias && currentUsername) {
   sidebarAlias.textContent = currentUsername;
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
     localStorage.removeItem('nexus-username');
     window.location.reload();
  });
}

if (leaveNetworkBtn) {
  leaveNetworkBtn.addEventListener('click', () => {
     if (!currentNetworkCode) return;
     
     if (confirm(`Are you sure you want to permanently abandon Subnet: ${currentNetworkCode}?`)) {
        savedNetworks = savedNetworks.filter(n => n.code !== currentNetworkCode);
        localStorage.setItem('nexus-saved-networks', JSON.stringify(savedNetworks));
        
        if (savedNetworks.length > 0) {
           currentNetworkCode = savedNetworks[0].code;
           localStorage.setItem('nexus-network', currentNetworkCode);
        } else {
           localStorage.removeItem('nexus-network');
        }
        window.location.reload();
     }
  });
}

// --- SHARED UI HELPERS ---
const customAlert = document.getElementById('custom-alert');
const customAlertTitle = document.getElementById('custom-alert-title');
const customAlertMessage = document.getElementById('custom-alert-message');
const customAlertClose = document.getElementById('custom-alert-close');

function showAlert(title, message) {
  customAlertTitle.textContent = title;
  customAlertMessage.innerHTML = message.replace(/\n/g, '<br/>');
  customAlert.classList.remove('hidden');
}

customAlertClose.addEventListener('click', () => customAlert.classList.add('hidden'));
