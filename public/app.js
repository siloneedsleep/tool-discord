// Lấy tham số từ URL
const params = new URLSearchParams(window.location.search);
const needPin = params.get('needPin');
const createPin = params.get('createPin');
const discordId = params.get('discordId');
const username = params.get('username');
const avatar = params.get('avatar');

const loginSection = document.getElementById('loginSection');
const createPinSection = document.getElementById('createPinSection');
const verifyPinSection = document.getElementById('verifyPinSection');

// Hiển thị form phù hợp
if (createPin === 'true' && discordId) {
  loginSection.classList.add('hidden');
  createPinSection.classList.remove('hidden');
} else if (needPin === 'true' && discordId) {
  loginSection.classList.add('hidden');
  verifyPinSection.classList.remove('hidden');
}

// Xử lý tạo PIN
document.getElementById('createPinBtn')?.addEventListener('click', async () => {
  const pin = document.getElementById('newPinInput').value.trim();
  if (!/^\d{8}$/.test(pin)) {
    document.getElementById('createPinError').textContent = 'PIN phải là 8 chữ số';
    return;
  }
  const res = await fetch('/api/auth/create-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordId, pin, username, avatar })
  });
  const data = await res.json();
  if (data.error) {
    document.getElementById('createPinError').textContent = data.error;
  } else if (data.redirect) {
    window.location.href = data.redirect;
  }
});

// Xử lý xác thực PIN
document.getElementById('verifyPinBtn')?.addEventListener('click', async () => {
  const pin = document.getElementById('pinInput').value.trim();
  if (!/^\d{8}$/.test(pin)) {
    document.getElementById('verifyPinError').textContent = 'Vui lòng nhập đúng 8 số';
    return;
  }
  const res = await fetch('/api/auth/verify-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordId, pin })
  });
  const data = await res.json();
  if (data.error) {
    document.getElementById('verifyPinError').textContent = data.error;
  } else if (data.redirect) {
    window.location.href = data.redirect;
  }
});
