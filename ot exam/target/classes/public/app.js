const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const views = ['loading-view', 'welcome-view', 'exam-view', 'result-view', 'admin-view'];
let exam = null;
let attemptId = null;
let currentQuestion = 0;
let answers = {};
let timerHandle = null;
let expiresAt = 0;
let toastHandle = null;
let submissionInProgress = false;

function showView(name) {
  views.forEach(id => document.getElementById(id).classList.toggle('hidden', id !== name));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
async function request(url, options = {}) {
  const headers = {'Content-Type': 'application/json'};
  if (url.startsWith('/api/admin')) {
    const password = sessionStorage.getItem('adminPassword');
    if (password) {
      headers['X-Admin-Password'] = password;
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {...options, signal: controller.signal, headers: {...headers, ...(options.headers || {})}});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) sessionStorage.removeItem('adminPassword');
      const error = new Error(data.error || 'Something went wrong. Please try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The server took too long to respond. Check that the site is running and try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => toast.classList.remove('show'), 3000);
}
function formatMarks(value) {
  return Number.isInteger(Number(value)) ? String(value) : Number(value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
async function loadExam() {
  try {
    exam = await request('/api/exam');
    $('#welcome-title').textContent = exam.settings.title;
    $('#welcome-duration').textContent = `${exam.settings.durationMinutes} min`;
    $('#welcome-questions').textContent = `${exam.questions.length} question${exam.questions.length === 1 ? '' : 's'}`;
    $('#welcome-penalty').textContent = `${formatMarks(exam.settings.negativeMarks)} ${Number(exam.settings.negativeMarks) === 1 ? 'mark' : 'marks'}`;
    showView('welcome-view');
  } catch (error) {
    $('#loading-view').innerHTML = `<p>${escapeHtml(error.message)}</p><button id="retry-load" class="secondary-button" type="button">Try again</button>`;
  }
}
async function startExam() {
  const button = $('#start-exam');
  button.disabled = true;
  try {
    const attempt = await request('/api/attempts', {method: 'POST', body: '{}'});
    attemptId = attempt.attemptId;
    submissionInProgress = false;
    expiresAt = attempt.expiresAt;
    currentQuestion = 0;
    answers = {};
    $('#exam-title-label').textContent = exam.settings.title.toUpperCase();
    showView('exam-view');
    renderQuestion();
    updateTimer();
    timerHandle = setInterval(updateTimer, 1000);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}
function renderQuestion() {
  const question = exam.questions[currentQuestion];
  const total = exam.questions.length;
  $('#question-number').textContent = `QUESTION ${String(currentQuestion + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  $('#question-mark').textContent = `+${formatMarks(exam.settings.correctMarks)} marks`;
  $('#question-progress-fill').style.width = `${((currentQuestion + 1) / total) * 100}%`;
  $('#question-text').textContent = question.text;
  const imageWrap = $('#question-image-wrap');
  imageWrap.classList.toggle('hidden', !question.image);
  if (question.image) $('#question-image').src = question.image;
  $('#answer-list').innerHTML = question.options.map((option, index) => `<button type="button" class="answer-option ${answers[question.id] === index ? 'selected' : ''}" data-answer="${index}"><span class="answer-letter">${String.fromCharCode(65 + index)}</span><span class="answer-text">${escapeHtml(option)}</span></button>`).join('');
  $('#question-nav').innerHTML = exam.questions.map((item, index) => `<button type="button" class="nav-question ${index === currentQuestion ? 'active' : ''} ${answers[item.id] !== undefined ? 'answered' : ''}" data-question="${index}" aria-label="Go to question ${index + 1}">${String(index + 1).padStart(2, '0')}</button>`).join('');
  $('#answered-count').textContent = `${Object.keys(answers).length} / ${total}`;
  $('#previous-question').disabled = currentQuestion === 0;
  $('#next-question').classList.toggle('hidden', currentQuestion === total - 1);
  $('#submit-exam').classList.toggle('hidden', currentQuestion !== total - 1);
}
function updateTimer() {
  const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const timer = $('#timer');
  $('strong', timer).textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  timer.classList.toggle('urgent', remaining <= 60);
  if (remaining === 0) {
    clearInterval(timerHandle);
    submitExam(true);
  }
}
async function submitExam(auto = false) {
  if (!attemptId || submissionInProgress) return;
  if (!auto && !confirm('Submit your exam now? You cannot change your answers after submitting.')) return;
  submissionInProgress = true;
  clearInterval(timerHandle);
  $('#submit-exam').disabled = true;
  try {
    const result = await request(`/api/attempts/${attemptId}/submit`, {method: 'POST', body: JSON.stringify({answers})});
    attemptId = null;
    renderResult(result, auto);
  } catch (error) {
    showToast(error.message);
    if (error.status === 410) {
      attemptId = null;
      setTimeout(() => loadExam(), 1000);
    } else if (attemptId) {
      if (Date.now() >= expiresAt) {
        setTimeout(() => submitExam(true), 5000);
      } else {
        timerHandle = setInterval(updateTimer, 1000);
      }
    }
  } finally {
    submissionInProgress = false;
    $('#submit-exam').disabled = false;
  }
}
function renderResult(result, auto) {
  const percent = result.maxScore > 0 ? Math.max(0, Math.round(result.score / result.maxScore * 100)) : 0;
  $('#result-view').innerHTML = `<div class="eyebrow"><span class="eyebrow-line"></span> EXAM COMPLETE</div><h1>${auto ? 'Time is up.' : 'Nicely done.'}</h1><p class="result-lead">${auto ? 'Your exam was submitted automatically when the timer ended.' : 'Here is how you did. Review your answers to see what to focus on next.'}</p><div class="result-summary"><div class="score-main"><strong>${formatMarks(result.score)}</strong><span>out of ${formatMarks(result.maxScore)} marks · ${percent}%</span></div><div class="result-stat"><strong>${result.correct}</strong><span>Correct</span></div><div class="result-stat"><strong>${result.wrong}</strong><span>Incorrect</span></div><div class="result-stat"><strong>${result.skipped}</strong><span>Skipped</span></div></div><h2 class="review-title">Answer review</h2><div id="review-list">${result.review.map((item, index) => {const selected = item.selectedIndex >= 0 ? item.options[item.selectedIndex] : 'No answer selected'; return `<article class="review-card"><div class="review-card-top"><h3>${String(index + 1).padStart(2, '0')}. ${escapeHtml(item.text)}</h3><span class="review-status ${item.status}">${item.status}</span></div>${item.image ? `<img class="review-image" src="${escapeHtml(item.image)}" alt="Question illustration">` : ''}<p class="review-answer">Your answer: <b>${escapeHtml(selected)}</b>${item.status !== 'correct' ? ` · Correct answer: <b>${escapeHtml(item.options[item.correctIndex])}</b>` : ''}</p></article>`;}).join('')}</div><div class="result-buttons"><button id="back-home" class="primary-button" type="button">Back to home <span>↗</span></button><button id="result-admin" class="secondary-button" type="button">Admin settings</button></div>`;
  showView('result-view');
}
async function openAdmin() {
  if (attemptId) { showToast('Finish your active exam before opening admin settings.'); return; }
  if (!sessionStorage.getItem('adminPassword')) {
    $('#login-error').textContent = '';
    $('#admin-password').value = '';
    $('#admin-login').classList.remove('hidden');
    $('#admin-password').focus();
    return;
  }
  await loadAdmin();
}
async function loadAdmin() {
  try {
    const [config, results] = await Promise.all([request('/api/admin'), request('/api/admin/results')]);
    renderAdmin(config, results);
    $('#admin-login').classList.add('hidden');
    showView('admin-view');
  } catch (error) {
    if (error.status === 401) sessionStorage.removeItem('adminPassword');
    if (error.status === 401) {
      $('#admin-login').classList.remove('hidden');
      $('#login-error').textContent = 'That password was not accepted. Please try again.';
      $('#admin-password').focus();
    } else {
      showToast(error.message);
    }
  }
}
function renderAdmin(config, results) {
  const settings = config.settings;
  const cards = config.questions.map((question, index) => questionEditor(question, index)).join('');
  $('#admin-view').innerHTML = `<div class="admin-heading"><div><div class="eyebrow"><span class="eyebrow-line"></span> EXAM MANAGEMENT</div><h1>Admin settings</h1><p>Manage your exam timing, scoring, and questions.</p></div><div class="admin-actions"><button id="admin-back" class="secondary-button" type="button">← Student view</button></div></div>${renderAdminResults(results)}<form id="admin-form"><section class="admin-settings"><h2 class="section-title">Exam setup</h2><div class="settings-grid"><div class="form-field"><label for="exam-title">Exam title</label><input id="exam-title" name="title" maxlength="80" required value="${escapeHtml(settings.title)}"></div><div class="form-field"><label for="exam-duration">Duration (minutes)</label><input id="exam-duration" name="durationMinutes" type="number" min="1" max="300" required value="${settings.durationMinutes}"></div><div class="form-field"><label for="correct-marks">Correct answer (+)</label><input id="correct-marks" name="correctMarks" type="number" min="0" step="0.25" required value="${settings.correctMarks}"></div><div class="form-field"><label for="negative-marks">Wrong answer (−)</label><input id="negative-marks" name="negativeMarks" type="number" min="0" step="0.25" required value="${settings.negativeMarks}"></div></div></section><div class="admin-list-heading"><h2 class="section-title">Question bank <span id="admin-question-count">(${config.questions.length})</span></h2></div><div id="question-editors">${cards}</div><div class="admin-foot"><span class="admin-hint">Questions and answer keys are saved on this server.</span><div class="admin-actions"><button id="add-question" class="secondary-button" type="button">＋ Add question</button><button class="primary-button" type="submit">Save changes <span>✓</span></button></div></div></form>`;
}
function renderAdminResults(results) {
  const rows = [...results].reverse().map((result, index) => {
    const date = new Date(result.completedAt);
    const completed = Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
    const review = result.review.map((item, questionIndex) => {
      const selected = item.selectedIndex >= 0 ? item.options[item.selectedIndex] : 'No answer';
      return `<li><strong>${String(questionIndex + 1).padStart(2, '0')}. ${escapeHtml(item.text)}</strong>${item.image ? `<img class="admin-review-image" src="${escapeHtml(item.image)}" alt="Question illustration">` : ''}<span>Your answer: ${escapeHtml(selected)}</span>${item.status !== 'correct' ? `<span>Correct answer: ${escapeHtml(item.options[item.correctIndex])}</span>` : ''}<span class="review-status ${item.status}">${escapeHtml(item.status)}</span></li>`;
    }).join('');
    return `<tr><td>${escapeHtml(String(result.attemptId).slice(0, 8))}</td><td>${escapeHtml(result.examTitle)}</td><td>${escapeHtml(completed)}</td><td>${formatMarks(result.score)} / ${formatMarks(result.maxScore)}</td><td>${result.correct} / ${result.totalQuestions}</td><td><details class="admin-result-review"><summary>View answers</summary><ol>${review}</ol></details></td></tr>`;
  }).join('');
  return `<section class="results-section"><div class="results-heading"><h2 class="section-title">Test results <span>(${results.length})</span></h2><button id="refresh-results" class="secondary-button" type="button">Refresh</button></div>${results.length ? `<div class="results-table-wrap"><table class="results-table"><thead><tr><th>Attempt</th><th>Exam</th><th>Completed</th><th>Score</th><th>Correct</th><th>Review</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="results-empty">Completed exam results will appear here.</p>'}</section>`;
}
function questionEditor(question, index) {
  const choices = question.options.map((option, optionIndex) => `<div class="form-field"><label>Choice ${String.fromCharCode(65 + optionIndex)}</label><input class="option-text" required value="${escapeHtml(option)}"></div>`).join('');
  return `<section class="question-editor" data-id="${escapeHtml(question.id)}" data-image="${escapeHtml(question.image || '')}"><div class="editor-head"><strong>Question ${String(index + 1).padStart(2, '0')}</strong><button class="remove-question" type="button">Remove</button></div><div class="form-field"><label>Question text</label><textarea class="question-text" required maxlength="500">${escapeHtml(question.text)}</textarea></div><div class="form-field question-image-field"><label>Question image</label><input class="question-image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif"><small>PNG, JPEG, WebP, or GIF; maximum 600 KB.</small><div class="question-image-preview ${question.image ? '' : 'hidden'}"><img src="${escapeHtml(question.image || '')}" alt="Question image preview"><button class="remove-image" type="button">Remove image</button></div></div><div class="editor-options">${choices}</div><div class="correct-answer-row form-field"><label>Correct answer</label><select class="correct-choice">${question.options.map((_, answerIndex) => `<option value="${answerIndex}" ${question.correctIndex === answerIndex ? 'selected' : ''}>${String.fromCharCode(65 + answerIndex)} — Choice ${String.fromCharCode(65 + answerIndex)}</option>`).join('')}</select></div></section>`;
}
function newQuestion() {
  const cards = $$('.question-editor', $('#question-editors'));
  const id = `q${Date.now()}${Math.floor(Math.random() * 1000)}`;
  $('#question-editors').insertAdjacentHTML('beforeend', questionEditor({id, text: '', options: ['', '', '', ''], correctIndex: 0}, cards.length));
  updateAdminCount();
  $('.question-text', $('#question-editors').lastElementChild).focus();
}
function updateAdminCount() {
  $('#admin-question-count').textContent = `(${$$('.question-editor', $('#question-editors')).length})`;
}
async function saveAdmin(event) {
  event.preventDefault();
  const form = event.target;
  if (!form.checkValidity()) {
    form.reportValidity?.();
    return;
  }
  const config = {
    settings: {
      title: $('#exam-title').value.trim(),
      durationMinutes: Number($('#exam-duration').value),
      correctMarks: Number($('#correct-marks').value),
      negativeMarks: Number($('#negative-marks').value)
    },
    questions: $$('.question-editor', $('#question-editors')).map(card => {
      const options = $$('.option-text', card).map(input => input.value.trim());
      return {id: card.dataset.id, text: $('.question-text', card).value.trim(), image: card.dataset.image || undefined, options, correctIndex: Number($('.correct-choice', card).value)};
    })
  };
  try {
    await request('/api/admin', {method: 'PUT', body: JSON.stringify(config)});
    exam = await request('/api/exam');
    showToast('Exam settings saved successfully.');
  } catch (error) { showToast(error.message); }
}

document.addEventListener('click', event => {
  const target = event.target;
  if (target.closest('#admin-open') || target.closest('#result-admin')) { openAdmin(); return; }
  if (target.closest('#admin-back') || target.closest('#back-home')) { loadExam(); return; }
  if (target.closest('#start-exam')) { startExam(); return; }
  if (target.closest('#retry-load')) { loadExam(); return; }
  if (target.closest('#previous-question')) { currentQuestion = Math.max(0, currentQuestion - 1); renderQuestion(); return; }
  if (target.closest('#next-question')) { currentQuestion = Math.min(exam.questions.length - 1, currentQuestion + 1); renderQuestion(); return; }
  if (target.closest('#submit-exam')) { submitExam(); return; }
  if (target.closest('#add-question')) { newQuestion(); return; }
  if (target.closest('#refresh-results')) { loadAdmin(); return; }
  const removeImage = target.closest('.remove-image');
  if (removeImage) {
    const card = removeImage.closest('.question-editor');
    card.dataset.image = '';
    $('.question-image-input', card).value = '';
    $('.question-image-preview', card).classList.add('hidden');
    return;
  }
  const answer = target.closest('[data-answer]');
  if (answer) { answers[exam.questions[currentQuestion].id] = Number(answer.dataset.answer); renderQuestion(); return; }
  const nav = target.closest('[data-question]');
  if (nav) { currentQuestion = Number(nav.dataset.question); renderQuestion(); return; }
  const remove = target.closest('.remove-question');
  if (remove) { remove.closest('.question-editor').remove(); $$('.question-editor', $('#question-editors')).forEach((card, index) => $('.editor-head strong', card).textContent = `Question ${String(index + 1).padStart(2, '0')}`); updateAdminCount(); }
});
document.addEventListener('change', event => {
  const input = event.target.closest('.question-image-input');
  if (!input || !input.files.length) return;
  const file = input.files[0];
  const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!allowedTypes.includes(file.type) || file.size > 600 * 1024) {
    showToast('Choose a PNG, JPEG, WebP, or GIF image under 600 KB.');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const card = input.closest('.question-editor');
    card.dataset.image = reader.result;
    $('.question-image-preview img', card).src = reader.result;
    $('.question-image-preview', card).classList.remove('hidden');
  };
  reader.onerror = () => showToast('The selected image could not be read.');
  reader.readAsDataURL(file);
});
document.addEventListener('submit', event => { if (event.target.id === 'admin-form') saveAdmin(event); });
document.addEventListener('submit', async event => {
  if (event.target.id !== 'admin-login-form') return;
  event.preventDefault();
  sessionStorage.setItem('adminPassword', $('#admin-password').value);
  $('#login-submit').disabled = true;
  try { await loadAdmin(); }
  finally { $('#login-submit').disabled = false; }
});
document.addEventListener('click', event => {
  if (event.target.closest('#login-close') || event.target.id === 'admin-login') {
    $('#admin-login').classList.add('hidden');
  }
});
loadExam();
