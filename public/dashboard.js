let token = '';
let ws = null;

// Lưu token vào server (gắn với user)
async function saveTokenToServer(tok) {
  await fetch('/api/save-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tok })
  });
}

// WebSocket
function connectWS() {
  if (ws) ws.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen = () => {
    if (token) ws.send(JSON.stringify({ event: 'auth', token }));
  };
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.event === 'questProgress') {
      updateQuestProgress(data.questId, data.percent, data.status, data.message);
    } else if (data.event === 'questQueueDone') {
      document.getElementById('questStatus').textContent = 'Hoàn thành tất cả quest!';
      document.getElementById('startQuests').classList.remove('hidden');
    } else if (data.event === 'questQueueAborted') {
      document.getElementById('questStatus').textContent = 'Hàng chờ quest đã bị hủy.';
      document.getElementById('startQuests').classList.remove('hidden');
    }
  };
}

// ========== UI Updates ==========
function updateUIForConnection(connected, user) {
  if (connected && user) {
    document.getElementById('userInfo').classList.remove('hidden');
    document.getElementById('avatar').src = user.avatarURL;
    document.getElementById('username').textContent = user.username;
    document.getElementById('connectBtn').classList.add('hidden');
    document.getElementById('disconnectBtn').classList.remove('hidden');
    document.getElementById('tokenInput').disabled = true;
    document.getElementById('fetchQuests').classList.remove('hidden');
  } else {
    document.getElementById('userInfo').classList.add('hidden');
    document.getElementById('connectBtn').classList.remove('hidden');
    document.getElementById('disconnectBtn').classList.add('hidden');
    document.getElementById('tokenInput').disabled = false;
    document.getElementById('fetchQuests').classList.add('hidden');
    document.getElementById('startQuests').classList.add('hidden');
    document.getElementById('questList').innerHTML = '';
    document.getElementById('questProgressContainer').innerHTML = '';
    document.getElementById('questProgressContainer').classList.add('hidden');
  }
}

// ========== API Helper ==========
async function apiRequest(url, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  return res.json();
}

// ========== Kết nối token ==========
document.getElementById('connectBtn').addEventListener('click', async () => {
  token = document.getElementById('tokenInput').value.trim();
  if (!token) return alert('Nhập token');
  const res = await apiRequest('/api/connect', 'POST', { token });
  if (res.error) return alert(res.error);
  updateUIForConnection(true, res);
  saveTokenToServer(token);
  connectWS();
});

// ========== Ngắt kết nối ==========
document.getElementById('disconnectBtn').addEventListener('click', async () => {
  await apiRequest('/api/disconnect', 'POST', { token });
  if (ws) ws.close();
  token = '';
  updateUIForConnection(false);
});

// ========== Tabs ==========
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    document.getElementById(btn.dataset.tab + '-tab').classList.remove('hidden');
  });
});

// ========== Presence ==========
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
  const res = await apiRequest('/api/presence', 'POST', data);
  const status = document.getElementById('presenceStatus');
  if (res.error) {
    status.textContent = 'Lỗi: ' + res.error;
    status.className = 'text-red-400 ml-3 text-sm';
  } else {
    status.textContent = 'Đã cập nhật presence thành công!';
    status.className = 'text-green-400 ml-3 text-sm';
  }
});

// ========== Voice ==========
document.getElementById('joinVoice').addEventListener('click', async () => {
  if (!token) return alert('Chưa kết nối');
  const channelId = document.getElementById('voiceChannelId').value.trim();
  const selfMute = document.getElementById('selfMute').checked;
  const selfDeaf = document.getElementById('selfDeaf').checked;
  if (!channelId) return alert('Nhập Channel ID');
  const res = await apiRequest('/api/voice/join', 'POST', { token, channelId, selfMute, selfDeaf });
  document.getElementById('voiceStatus').textContent = res.error ? `Lỗi: ${res.error}` : 'Đã vào phòng voice (tự động reconnect)';
});

document.getElementById('leaveVoice').addEventListener('click', async () => {
  if (!token) return;
  const res = await apiRequest('/api/voice/leave', 'POST', { token });
  document.getElementById('voiceStatus').textContent = res.error ? `Lỗi: ${res.error}` : 'Đã rời phòng voice';
});

// ========== Quests ==========
document.getElementById('fetchQuests').addEventListener('click', async () => {
  if (!token) return;
  document.getElementById('questStatus').textContent = 'Đang tải...';
  const quests = await apiRequest(`/api/quests?token=${encodeURIComponent(token)}`);
  if (quests.error) {
    document.getElementById('questStatus').textContent = 'Lỗi: ' + quests.error;
    return;
  }
  renderQuestList(quests);
  document.getElementById('questStatus').textContent = `Tìm thấy ${quests.length} quest khả dụng.`;
});

function renderQuestList(quests) {
  const container = document.getElementById('questList');
  container.innerHTML = '';
  if (quests.length === 0) {
    container.innerHTML = '<p class="text-gray-400">Không có quest nào cần làm.</p>';
    document.getElementById('startQuests').classList.add('hidden');
    return;
  }
  quests.forEach(q => {
    const card = document.createElement('div');
    card.className = 'bg-gray-700 p-4 rounded-lg flex items-center gap-4';
    card.innerHTML = `
      <input type="checkbox" class="quest-checkbox" value="${q.id}">
      <div class="flex-1">
        <h3 class="font-medium">${q.name}</h3>
        <p class="text-sm text-gray-400">${q.gamePublisher} - ${q.questType} - ${q.durationMinutes} phút</p>
      </div>
      <span class="text-xs bg-gray-600 px-2 py-1 rounded">${q.status}</span>
    `;
    container.appendChild(card);
  });
  document.getElementById('startQuests').classList.remove('hidden');
}

document.getElementById('startQuests').addEventListener('click', async () => {
  if (!token) return;
  const checked = document.querySelectorAll('.quest-checkbox:checked');
  const questIds = Array.from(checked).map(cb => cb.value);
  if (questIds.length === 0) return alert('Chọn ít nhất một quest');
  const res = await apiRequest('/api/quests/start', 'POST', { token, questIds });
  if (res.error) {
    document.getElementById('questStatus').textContent = 'Lỗi: ' + res.error;
    return;
  }
  document.getElementById('questStatus').textContent = 'Hàng chờ đã bắt đầu...';
  document.getElementById('startQuests').classList.add('hidden');
  
  // Tạo progress bars
  const progressContainer = document.getElementById('questProgressContainer');
  progressContainer.innerHTML = '';
  progressContainer.classList.remove('hidden');
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
    progressContainer.appendChild(barDiv);
  });
});

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

// Kết nối WebSocket khi load trang (nếu token đã lưu có thể thử kết nối)
window.addEventListener('load', () => {
  connectWS();
});
