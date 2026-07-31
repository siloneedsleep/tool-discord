let token = '';
let ws = null;

// DOM elements
const tokenInput = document.getElementById('tokenInput');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const userInfo = document.getElementById('userInfo');
const avatarImg = document.getElementById('avatar');
const usernameSpan = document.getElementById('username');
const userIdSpan = document.getElementById('userId');
const presenceStatus = document.getElementById('presenceStatus');
const voiceStatus = document.getElementById('voiceStatus');
const questStatus = document.getElementById('questStatus');
const fetchQuestsBtn = document.getElementById('fetchQuests');
const startQuestsBtn = document.getElementById('startQuests');
const questList = document.getElementById('questList');
const questProgressContainer = document.getElementById('questProgressContainer');

// Tabs
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tabId = btn.dataset.tab;
    tabContents.forEach(content => {
      content.classList.toggle('active', content.id === tabId + '-tab');
    });
  });
});

// WebSocket setup
function connectWebSocket() {
  if (ws) ws.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen = () => {
    if (token) {
      ws.send(JSON.stringify({ event: 'auth', token }));
    }
  };
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.event === 'questProgress') {
      updateQuestProgress(data.questId, data.percent, data.status, data.message);
    } else if (data.event === 'questQueueDone') {
      questStatus.textContent = 'Tất cả quest đã hoàn thành.';
      startQuestsBtn.classList.remove('hidden');
    } else if (data.event === 'questQueueAborted') {
      questStatus.textContent = 'Hàng chờ quest đã bị hủy.';
      startQuestsBtn.classList.remove('hidden');
    }
  };
}

// Update UI after connect/disconnect
function updateUIForConnection(connected, user) {
  if (connected && user) {
    userInfo.classList.remove('hidden');
    avatarImg.src = user.avatarURL;
    usernameSpan.textContent = user.username + (user.discriminator !== '0' ? '#' + user.discriminator : '');
    userIdSpan.textContent = `ID: ${user.id}`;
    connectBtn.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
    tokenInput.disabled = true;
    // Enable quest fetch
    fetchQuestsBtn.classList.remove('hidden');
  } else {
    userInfo.classList.add('hidden');
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
    tokenInput.disabled = false;
    fetchQuestsBtn.classList.add('hidden');
    startQuestsBtn.classList.add('hidden');
    questList.innerHTML = '';
    questProgressContainer.innerHTML = '';
    questProgressContainer.classList.add('hidden');
  }
}

// API request helper
async function apiRequest(url, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  return res.json();
}

// Connect token
connectBtn.addEventListener('click', async () => {
  token = tokenInput.value.trim();
  if (!token) return alert('Vui lòng nhập token');
  try {
    const data = await apiRequest('/api/connect', 'POST', { token });
    if (data.error) {
      alert('Lỗi: ' + data.error);
      return;
    }
    updateUIForConnection(true, data);
    connectWebSocket();
  } catch (e) {
    alert('Kết nối thất bại');
  }
});

// Disconnect
disconnectBtn.addEventListener('click', async () => {
  if (!token) return;
  await apiRequest('/api/disconnect', 'POST', { token });
  updateUIForConnection(false);
  if (ws) ws.close();
  token = '';
  tokenInput.value = '';
});

// Apply Presence
document.getElementById('applyPresence').addEventListener('click', async () => {
  if (!token) return alert('Chưa kết nối token');
  const data = {
    token,
    type: document.getElementById('type').value,
    name: document.getElementById('name').value,
    details: document.getElementById('details').value,
    state: document.getElementById('state').value,
    applicationId: document.getElementById('appId').value,
    largeImageKey: document.getElementById('largeImage').value,
    largeImageText: document.getElementById('largeImageText').value,
    smallImageKey: document.getElementById('smallImage').value,
    smallImageText: document.getElementById('smallImageText').value,
    button1Text: document.getElementById('btn1Text').value,
    button1Url: document.getElementById('btn1Url').value,
    button2Text: document.getElementById('btn2Text').value,
    button2Url: document.getElementById('btn2Url').value
  };
  try {
    const res = await apiRequest('/api/presence', 'POST', data);
    if (res.error) {
      presenceStatus.textContent = 'Lỗi: ' + res.error;
      presenceStatus.className = 'text-red-400 ml-3 text-sm';
    } else {
      presenceStatus.textContent = 'Đã cập nhật presence thành công!';
      presenceStatus.className = 'text-green-400 ml-3 text-sm';
    }
  } catch (e) {
    presenceStatus.textContent = 'Lỗi kết nối';
  }
});

// Voice Join
document.getElementById('joinVoice').addEventListener('click', async () => {
  if (!token) return alert('Chưa kết nối');
  const channelId = document.getElementById('voiceChannelId').value.trim();
  const selfMute = document.getElementById('selfMute').checked;
  const selfDeaf = document.getElementById('selfDeaf').checked;
  if (!channelId) return alert('Nhập Channel ID');
  const res = await apiRequest('/api/voice/join', 'POST', { token, channelId, selfMute, selfDeaf });
  voiceStatus.textContent = res.error ? `Lỗi: ${res.error}` : 'Đã vào phòng voice (tự động reconnect nếu mất kết nối)';
});

// Voice Leave
document.getElementById('leaveVoice').addEventListener('click', async () => {
  if (!token) return;
  const res = await apiRequest('/api/voice/leave', 'POST', { token });
  voiceStatus.textContent = res.error ? `Lỗi: ${res.error}` : 'Đã rời phòng voice';
});

// Fetch Quests
fetchQuestsBtn.addEventListener('click', async () => {
  if (!token) return;
  questStatus.textContent = 'Đang tải...';
  try {
    const quests = await apiRequest(`/api/quests?token=${encodeURIComponent(token)}`);
    if (quests.error) {
      questStatus.textContent = 'Lỗi: ' + quests.error;
      return;
    }
    renderQuestList(quests);
    questStatus.textContent = `Tìm thấy ${quests.length} quest khả dụng.`;
  } catch (e) {
    questStatus.textContent = 'Lỗi kết nối';
  }
});

function renderQuestList(quests) {
  questList.innerHTML = '';
  if (quests.length === 0) {
    questList.innerHTML = '<p class="text-gray-400">Không có quest nào cần làm.</p>';
    startQuestsBtn.classList.add('hidden');
    return;
  }
  quests.forEach(q => {
    const card = document.createElement('div');
    card.className = 'bg-gray-700 p-4 rounded-lg flex items-center gap-4';
    card.innerHTML = `
      <input type="checkbox" class="quest-checkbox" value="${q.id}" class="mr-3">
      <div class="flex-1">
        <h3 class="font-medium">${q.name}</h3>
        <p class="text-sm text-gray-400">${q.gamePublisher} - ${q.questType} - ${q.durationMinutes} phút</p>
      </div>
      <span class="text-xs bg-gray-600 px-2 py-1 rounded">${q.status}</span>
    `;
    questList.appendChild(card);
  });
  startQuestsBtn.classList.remove('hidden');
}

// Start selected quests
startQuestsBtn.addEventListener('click', async () => {
  if (!token) return;
  const checked = document.querySelectorAll('.quest-checkbox:checked');
  const questIds = Array.from(checked).map(cb => cb.value);
  if (questIds.length === 0) return alert('Chọn ít nhất một quest');
  const res = await apiRequest('/api/quests/start', 'POST', { token, questIds });
  if (res.error) {
    questStatus.textContent = 'Lỗi: ' + res.error;
    return;
  }
  questStatus.textContent = 'Hàng chờ đã bắt đầu...';
  startQuestsBtn.classList.add('hidden');
  // Tạo progress bars
  questProgressContainer.innerHTML = '';
  questProgressContainer.classList.remove('hidden');
  questIds.forEach(id => {
    const barDiv = document.createElement('div');
    barDiv.className = 'mb-2';
    barDiv.id = `progress-${id}`;
    barDiv.innerHTML = `
      <div class="flex justify-between text-sm mb-1">
        <span>Quest ${id.slice(-6)}</span>
        <span class="percent">0%</span>
      </div>
      <div class="w-full bg-gray-700 rounded-full h-3">
        <div class="progress-bar bg-blue-500 h-3 rounded-full" style="width: 0%"></div>
      </div>
      <span class="status-text text-xs text-gray-400"></span>
    `;
    questProgressContainer.appendChild(barDiv);
  });
});

// Cập nhật progress từ WebSocket
function updateQuestProgress(questId, percent, status, message) {
  const container = document.getElementById(`progress-${questId}`);
  if (!container) return;
  const bar = container.querySelector('.progress-bar');
  const percentSpan = container.querySelector('.percent');
  const statusText = container.querySelector('.status-text');
  bar.style.width = percent + '%';
  percentSpan.textContent = percent + '%';
  statusText.textContent = status + (message ? ': ' + message : '');
  if (status === 'completed') {
    bar.classList.remove('bg-blue-500');
    bar.classList.add('bg-green-500');
  } else if (status === 'error') {
    bar.classList.remove('bg-blue-500');
    bar.classList.add('bg-red-500');
  }
}

// Kết nối WebSocket khi load trang
window.addEventListener('load', () => {
  connectWebSocket();
});
