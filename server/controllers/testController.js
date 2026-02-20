const banditService = require("../services/banditService");
const { saveAssessmentResultHelper } = require("./studentController");
const { v4: uuidv4 } = require("uuid");

exports.getNextQuestion = async (req, res) => {
  try {
    const { student_id, assessment_id } = req.query;

    if (!student_id || !assessment_id) {
      return res.status(400).json({ error: "student_id and assessment_id required" });
    }

    // ================= STUDENT UUID =================
    const studentResult = await req.pool.query(
      "SELECT id FROM students WHERE student_id = $1",
      [student_id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: "Student not found" });
    }

    const studentUUID = studentResult.rows[0].id;

    // ================= ENSURE ATTEMPT =================
    await req.pool.query(
      `
      INSERT INTO student_assessments (
        id, student_id, assessment_id, start_time, answers, asked_questions
      )
      VALUES ($1, $2, $3, NOW(), '[]', '[]')
      ON CONFLICT (student_id, assessment_id) DO NOTHING
      `,
      [uuidv4(), studentUUID, assessment_id]
    );

    // ================= LOAD ATTEMPT =================
    const attemptRes = await req.pool.query(
      `
      SELECT completed, answers, asked_questions
      FROM student_assessments
      WHERE student_id = $1 AND assessment_id = $2
      `,
      [studentUUID, assessment_id]
    );

    const attempt = attemptRes.rows[0];

    if (attempt.completed) {
      return res.json({ done: true, message: "Already completed" });
    }

    const answers = Array.isArray(attempt.answers) ? attempt.answers : [];
    const askedQuestions = Array.isArray(attempt.asked_questions)
      ? attempt.asked_questions
      : [];

    // ================= LOAD ASSESSMENT =================
    const assessmentResult = await req.pool.query(
      "SELECT questions, questions_to_attempt FROM assessments WHERE id = $1",
      [assessment_id]
    );

    if (assessmentResult.rows.length === 0) {
      return res.status(404).json({ error: "Assessment not found" });
    }

    const questions = Array.isArray(assessmentResult.rows[0].questions)
      ? assessmentResult.rows[0].questions
      : [];

    const questionsToAttempt = assessmentResult.rows[0].questions_to_attempt;
    const maxQuestions = Math.max(Number(questionsToAttempt) || 0, 15);

    // ================= QUESTION LIMIT CHECK =================
    if (askedQuestions.length >= maxQuestions) {
      return res.json({
        done: true,
        message: "Question limit reached"
      });
    }

    const answeredIds = answers.map(a => a.question_id);
    const askedIds = askedQuestions.map(q => q.question_id);

    // ================= BANDIT DIFFICULTY =================
    const difficulty = Number(
      await banditService.getNextDifficulty(studentUUID)
    );

    // ================= FILTER QUESTIONS =================
    let available = questions.filter(
      q =>
        q.difficulty === difficulty &&
        !answeredIds.includes(q.id) &&
        !askedIds.includes(q.id)
    );

    // fallback
    if (available.length === 0) {
      for (let offset = 1; offset <= 4 && available.length === 0; offset++) {
        available = questions.filter(
          q =>
            Math.abs(q.difficulty - difficulty) === offset &&
            !answeredIds.includes(q.id) &&
            !askedIds.includes(q.id)
        );
      }
    }

    if (available.length === 0) {
      return res.json({ done: true, message: "No more questions" });
    }

    const question = available[Math.floor(Math.random() * available.length)];

    // ================= SAVE ASKED QUESTION =================
    await req.pool.query(
      `
      UPDATE student_assessments
      SET asked_questions = asked_questions || $1::jsonb
      WHERE student_id = $2 AND assessment_id = $3
      `,
      [
        JSON.stringify([{
          question_id: question.id,
          difficulty: question.difficulty,
          asked_at: new Date().toISOString()
        }]),
        studentUUID,
        assessment_id
      ]
    );

    // ================= SEND QUESTION =================
    res.json({
      question_id: question.id,
      question: question.text,
      difficulty: question.difficulty,
      options: question.options
    });

  } catch (err) {
    console.error("getNextQuestion error:", err);
    res.status(500).json({ error: "Failed to fetch question" });
  }
};


exports.completeAssessment = async (req, res) => {
  try {
    const { student_id, assessment_id } = req.body;

    if (!student_id || !assessment_id) {
      return res.status(400).json({ error: "Invalid session" });
    }

    // 1️⃣ Get student UUID and name
    const studentRes = await req.pool.query(
      "SELECT id, full_name FROM students WHERE student_id = $1",
      [student_id]
    );
    if (studentRes.rows.length === 0) return res.status(404).json({ error: "Student not found" });

    const studentUUID = studentRes.rows[0].id;
    const studentName = studentRes.rows[0].full_name;

    // 2️⃣ Fetch assessment attempt
    const attemptRes = await req.pool.query(
      "SELECT id, completed, answers, start_time FROM student_assessments WHERE student_id = $1 AND assessment_id = $2",
      [studentUUID, assessment_id]
    );
    if (attemptRes.rows.length === 0) return res.status(404).json({ error: "Assessment attempt not found" });

    const attempt = attemptRes.rows[0];
    if (attempt.completed) return res.json({ message: "Already completed" });

    // 3️⃣ Fetch assessment info
    const assessmentRes = await req.pool.query(
      "SELECT questions, questions_to_attempt, pass_score FROM assessments WHERE id = $1",
      [assessment_id]
    );
    if (assessmentRes.rows.length === 0) return res.status(404).json({ error: "Assessment not found" });

    const assessment = assessmentRes.rows[0];
    const passingScore = Number(assessment.pass_score) || 50;

    // 4️⃣ Parse answers
    const answers = Array.isArray(attempt.answers) ? attempt.answers : JSON.parse(attempt.answers || "[]");
    const correctCount = answers.filter(a => a.correct === true).length;
    const total = answers.length;
    const score = total > 0 ? (correctCount / total) * 100 : 0;

    // 5️⃣ Calculate time used (in seconds)
    const startTime = attempt.start_time ? new Date(attempt.start_time) : new Date();
    const endTime = new Date();
    const timeUsed = Math.round((endTime - startTime) / 1000);

    // 6️⃣ Update student_assessments
    await req.pool.query(
      `UPDATE student_assessments
       SET completed = TRUE,
           end_time = CURRENT_TIMESTAMP,
           score = $3,
           time_spent = $4
       WHERE student_id = $1 AND assessment_id = $2`,
      [studentUUID, assessment_id, score, timeUsed]
    );

    // 7️⃣ Save to dedicated results table
    const studentFullResult = {
      studentId: student_id,
      assessmentId: assessment_id,
      studentName,
      responses: answers,
      percentage: score,
      passed: score >= passingScore,
      timeUsed
    };
    await saveAssessmentResultHelper(req.pool, studentFullResult);

    console.log("✅ Assessment completed");

    return res.json({
      success: true,
      score,
      passed: studentFullResult.passed,
      timeUsed
    });

  } catch (err) {
    console.error("completeAssessment error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};