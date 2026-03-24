let currentQuestion = null;
let questionCount = 0;
let assessmentStartTime = null;
let assessmentSubmitted = false;

let timerInterval;
let timeRemaining;

let studentId = "";
let assessmentId = "";
let assessmentTitle = "";

// ================= INIT =================
document.addEventListener("DOMContentLoaded", () => {
  studentId = sessionStorage.getItem("studentId");
  assessmentId = sessionStorage.getItem("assessmentId");
  assessmentTitle = sessionStorage.getItem("assessmentTitle") || "Assessment";

  if (!studentId || !assessmentId) {
    alert("Session expired. Please login again.");
    window.location.href = "/student/login.html";
    return;
  }

  document.getElementById("quizTitle").textContent = assessmentTitle;
  document.getElementById("studentInfo").textContent = `Student ID: ${studentId}`;

  assessmentStartTime = Date.now(); 
  startTimer();
  loadNextQuestion();
});

// ================= TIMER =================
function startTimer() {
  const durationMinutes =
    parseInt(sessionStorage.getItem("assessmentDuration")) || 45;

  timeRemaining = durationMinutes * 60;

  timerInterval = setInterval(() => {
    timeRemaining--;
    updateTimer();

    if (timeRemaining <= 0) {
      clearInterval(timerInterval);
      submitAssessment();
    }
  }, 1000);
}

function updateTimer() {
  const min = Math.floor(timeRemaining / 60);
  const sec = timeRemaining % 60;

  document.getElementById("timer").textContent =
    `Time Remaining: ${min.toString().padStart(2, "0")}:${sec
      .toString()
      .padStart(2, "0")}`;
}

// ================= FETCH NEXT QUESTION =================
async function loadNextQuestion() {
  try {

    const res = await fetch(
      `/api/test/next-question?student_id=${studentId}&assessment_id=${assessmentId}`
    );

    const data = await res.json();

    if (data.done) {
      submitAssessment();
      return;
    }

    renderQuestion(data);
    questionCount++;

  } catch (err) {
    console.error("Failed to load question", err);
    alert("Error loading question");
  }
}

// ================= RENDER QUESTION =================
function renderQuestion(q) {
  currentQuestion = q;

  document.getElementById("questionNumber").textContent =
    `Question ${questionCount + 1}`;

  document.getElementById("progressBar").style.width =
    `${Math.min(questionCount * 5, 100)}%`;

  document.getElementById("questionText").textContent = q.question;

  document.getElementById("questionMeta").innerHTML =
    `<span class="badge">Difficulty: ${q.difficulty}</span>`;

  const optionsContainer = document.getElementById("optionsContainer");
  optionsContainer.style.display = "block"; 
  optionsContainer.innerHTML = ""; 


  q.options.forEach((opt, idx) => {
    const div = document.createElement("div");
    div.className = "option-item";
    div.textContent = opt;

    div.onclick = async () => {
      disableOptions();
      await submitAnswer(q.question_id, idx);
      loadNextQuestion();
    };

    optionsContainer.appendChild(div);
  });
}

function disableOptions() {
  document.querySelectorAll(".option-item").forEach(opt => {
    opt.style.pointerEvents = "none";
    opt.style.opacity = "0.6";
  });
}

// ================= SUBMIT ANSWER =================
async function submitAnswer(questionId, selectedOption) {
  try {
    const res = await fetch("/api/test/submit-answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        student_id: studentId,
        assessment_id: assessmentId,
        question_id: questionId,
        selected_option: selectedOption
      })
    });

    if (!res.ok) {
      alert("Answer submission failed");
      submitAssessment();
    }
  } catch {
    submitAssessment();
  }
}

// ================= FINAL SUBMIT =================
async function submitAssessment() {
  if (assessmentSubmitted) return;
  assessmentSubmitted = true;

  clearInterval(timerInterval);

  const timeSpentSeconds = Math.floor(
    (Date.now() - assessmentStartTime) / 1000
  );

  const res = await fetch("/api/test/complete-assessment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      student_id: studentId,
      assessment_id: assessmentId,
      time_spent: timeSpentSeconds
    })
  });

  const data = await res.json();

  if (res.ok && data.success) {
    alert("Assessment completed!");
    window.location.href = "/student/dashboard.html";
  } else {
    alert(data.error || "Failed to complete assessment");
  }
}
