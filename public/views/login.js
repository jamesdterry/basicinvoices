import { postJson } from '/lib/api.js';

const ERR_MESSAGES = {
  invalid: 'That sign-in link is invalid or has already been used.',
  expired: 'That sign-in link has expired. Request a new one.',
  rate_limited: 'Too many attempts — try again in a few minutes.',
};

const status = document.getElementById('login-status');
function showStatus(text, kind = 'muted') {
  status.textContent = text;
  status.hidden = false;
  status.className = kind;
}

const params = new URLSearchParams(window.location.search);
const errCode = params.get('err');
if (errCode) showStatus(ERR_MESSAGES[errCode] || 'Sign-in failed.');

const magicForm = document.getElementById('magic-link-form');
magicForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = new FormData(magicForm).get('email');
  const btn = magicForm.querySelector('button');
  btn.disabled = true;
  try {
    await postJson('/auth/magic-link', { email });
    showStatus('Check your email — if that address has an account, a sign-in link is on its way.');
    magicForm.reset();
  } catch (err) {
    if (err.status === 429) {
      showStatus(ERR_MESSAGES.rate_limited);
    } else {
      showStatus('Could not send sign-in link. Try again.');
    }
  } finally {
    btn.disabled = false;
  }
});

const passwordForm = document.getElementById('password-form');
passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(passwordForm);
  const btn = passwordForm.querySelector('button');
  btn.disabled = true;
  try {
    await postJson('/auth/password', { email: fd.get('email'), password: fd.get('password') });
    window.location.assign('/');
  } catch (err) {
    if (err.status === 429) showStatus(ERR_MESSAGES.rate_limited);
    else showStatus('Sign-in failed. Check your email and password.');
  } finally {
    btn.disabled = false;
  }
});
