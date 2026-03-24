const bcrypt = require('bcryptjs');
const format = require('pg-format');
const { v4: uuidv4 } = require('uuid');

// Helper duplicated from server.js (or should be in a utils file)
function getResultsTableName(assessmentCode) {
    if (!assessmentCode || typeof assessmentCode !== 'string') {
        throw new Error('Invalid assessment code for table name generation.');
    }
    const sanitized = assessmentCode.toLowerCase().replace(/[^a-z0-9]/g, '_');
    return `results_for_${sanitized}`;
}

// Helper to ensure results table exists
async function createAssessmentResultsTable(pool, assessmentCode) {
    const tableName = getResultsTableName(assessmentCode);
    const createTableQuery = format(`
        CREATE TABLE IF NOT EXISTS %I (
            id UUID PRIMARY KEY,
            student_uuid UUID REFERENCES students(id) ON DELETE SET NULL,
            student_identifier TEXT NOT NULL,
            student_name TEXT NOT NULL,
            assessment_id UUID NOT NULL,
            score_percentage DECIMAL(5, 2) NOT NULL,
            passed BOOLEAN NOT NULL,
            time_spent_seconds INTEGER NOT NULL,
            responses JSONB,
            submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `, tableName);

    try {
        await pool.query(createTableQuery);
        console.log(`Ensured dedicated results table '${tableName}' exists.`);
    } catch (err) {
        console.error(`Error creating results table '${tableName}':`, err);
        throw err;
    }
}

exports.saveAssessmentResultHelper = async (pool, data) => {
  const { studentId, assessmentId, studentName, responses, percentage, passed, timeUsed } = data;

  if (!studentId || !assessmentId || !studentName || responses === undefined || percentage === undefined || passed === undefined || timeUsed === undefined) {
    throw new Error("Missing required result data");
  }

  // Get student UUID
  const studentRes = await pool.query('SELECT id FROM students WHERE student_id = $1', [studentId]);
  if (studentRes.rows.length === 0) throw new Error(`Student ${studentId} not found`);
  const studentUUID = studentRes.rows[0].id;

  // Get assessment code
  const assessmentRes = await pool.query('SELECT code FROM assessments WHERE id = $1', [assessmentId]);
  if (assessmentRes.rows.length === 0) throw new Error("Assessment not found");
  const assessmentCode = assessmentRes.rows[0].code;

  // Ensure results table exists
  await createAssessmentResultsTable(pool, assessmentCode);
  const tableName = getResultsTableName(assessmentCode);

  // Insert into dedicated table
  const insertQuery = format(
    'INSERT INTO %I (id, student_uuid, student_identifier, student_name, assessment_id, score_percentage, passed, time_spent_seconds, responses) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    tableName
  );

  await pool.query(insertQuery, [
    uuidv4(),
    studentUUID,
    studentId,
    studentName,
    assessmentId,
    percentage,
    passed,
    timeUsed,
    JSON.stringify(responses)
  ]);

  // Also update main student_assessments table
  await pool.query(
    `UPDATE student_assessments
     SET end_time = CURRENT_TIMESTAMP, completed = true, answers = $1, score = $2, time_spent = $3
     WHERE student_id = $4 AND assessment_id = $5 AND completed = false`,
    [JSON.stringify(responses), percentage, timeUsed, studentUUID, assessmentId]
  );

  return true;
};

exports.getStudentById = async (req, res, pool) => {
    try {
        const { id } = req.params;
        console.log('Fetching student with ID:', id);

        if (!id) return res.status(400).json({ message: 'Student ID is required' });

        const result = await pool.query(
            'SELECT id, first_name, last_name, full_name, email, student_id, created_at, updated_at, status FROM students WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Student not found' });
        }

        const student = result.rows[0];
        res.status(200).json({
            success: true,
            student: {
                id: student.id,
                firstName: student.first_name,
                lastName: student.last_name,
                fullName: student.full_name,
                email: student.email,
                studentId: student.student_id,
                createdAt: student.created_at,
                updatedAt: student.updated_at,
                status: student.status || 'active'
            }
        });
    } catch (error) {
        console.error('Error fetching student:', error);
        res.status(500).json({ success: false, message: 'Server error while fetching student', error: error.message });
    }
};

const emailService = require('../services/emailService');

exports.updateStudent = async (req, res, pool) => {
    try {
        const { id } = req.params;
        const { firstName, lastName, email, status, password } = req.body;
        console.log('Updating student with ID:', id);

        if (!firstName || !lastName || !email) {
            return res.status(400).json({ message: 'First name, last name, and email are required' });
        }

        const existingStudent = await pool.query('SELECT * FROM students WHERE id = $1', [id]);
        if (existingStudent.rows.length === 0) return res.status(404).json({ message: 'Student not found' });

        const emailCheck = await pool.query('SELECT * FROM students WHERE email = $1 AND id != $2', [email, id]);
        if (emailCheck.rows.length > 0) return res.status(400).json({ message: 'Email already registered' });

        const fullName = `${firstName} ${lastName}`;
        const studentStatus = status || 'active';
        let updateQuery, queryParams;
        let passwordChanged = false;

        if (password) {
            if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters long' });
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            updateQuery = `
                UPDATE students 
                SET first_name = $1, last_name = $2, full_name = $3, email = $4, status = $5, password = $6, updated_at = CURRENT_TIMESTAMP
                WHERE id = $7 
                RETURNING id, first_name, last_name, full_name, email, student_id, created_at, updated_at, status
            `;
            queryParams = [firstName, lastName, fullName, email, studentStatus, hashedPassword, id];
            passwordChanged = true;
        } else {
            updateQuery = `
                UPDATE students 
                SET first_name = $1, last_name = $2, full_name = $3, email = $4, status = $5, updated_at = CURRENT_TIMESTAMP
                WHERE id = $6 
                RETURNING id, first_name, last_name, full_name, email, student_id, created_at, updated_at, status
            `;
            queryParams = [firstName, lastName, fullName, email, studentStatus, id];
        }

        const result = await pool.query(updateQuery, queryParams);
        const updatedStudent = result.rows[0];

        // Send Notification Email
        await emailService.sendProfileUpdateEmail(updatedStudent.email, updatedStudent.full_name, passwordChanged);

        res.status(200).json({
            success: true,
            message: 'Student updated successfully',
            student: {
                id: updatedStudent.id,
                firstName: updatedStudent.first_name,
                lastName: updatedStudent.last_name,
                fullName: updatedStudent.full_name,
                email: updatedStudent.email,
                studentId: updatedStudent.student_id,
                createdAt: updatedStudent.created_at,
                updatedAt: updatedStudent.updated_at,
                status: updatedStudent.status
            }
        });
    } catch (error) {
        console.error('Error updating student:', error);
        res.status(500).json({ success: false, message: 'Server error during update', error: error.message });
    }
};

exports.getAllResults = async (req, res, pool) => {
    try {
        const { studentId } = req.params;

        const studentResult = await pool.query(
            'SELECT id FROM students WHERE student_id = $1',
            [studentId]
        );

        if (studentResult.rows.length === 0) {
            return res.status(404).json({ message: 'Student not found' });
        }

        const dbStudentId = studentResult.rows[0].id;

        const result = await pool.query(
            `SELECT 
                a.title,
                sa.end_time,
                sa.score,
                sa.completed
             FROM student_assessments sa
             JOIN assessments a ON sa.assessment_id = a.id
             WHERE sa.student_id = $1
             ORDER BY sa.end_time DESC`,
            [dbStudentId]
        );

        res.json(result.rows);

    } catch (error) {
        console.error("Error fetching all results:", error);
        res.status(500).json({ message: "Server error" });
    }
};

exports.getStudentResults = async (req, res, pool) => {
    try {
        const { studentId } = req.params;
        const { assessmentId } = req.query;

        if (!assessmentId) {
            return res.status(400).json({ message: "assessmentId is required" });
        }

        const studentResult = await pool.query(
            'SELECT id, full_name FROM students WHERE student_id = $1',
            [studentId]
        );

        if (studentResult.rows.length === 0)
            return res.status(404).json({ message: 'Student not found' });

        const student = studentResult.rows[0];

        const saResult = await pool.query(
            `SELECT sa.*, a.title, a.questions, a.pass_score
             FROM student_assessments sa
             JOIN assessments a ON sa.assessment_id = a.id
             WHERE sa.student_id = $1 
             AND a.code = $2
             AND sa.completed = true`,
            [student.id, assessmentId]
        );

        if (saResult.rows.length === 0)
            return res.status(404).json({ message: 'No completed assessment found' });

        const sa = saResult.rows[0];
        const studentResponses = sa.answers || [];
        const questionBank = sa.questions || [];

        const questionMap = new Map(
            questionBank.map(q => [q.id, q])
        );

        const detailedResponses = [];
        let correctCount = 0;
        let weightedScore = 0;
        let totalWeight = 0;
        for (let response of studentResponses) {
            const question = questionMap.get(response.question_id);
            if (!question) continue;

            const weight = question.difficulty || 1; 
            totalWeight += weight;

            const isCorrect = response.selected_option === question.correctAnswer;

            if (isCorrect) {
                weightedScore += weight;
            }

            detailedResponses.push({
                questionText: question.text,
                studentAnswerText: question.options?.[response.selected_option],
                correctAnswerText: question.options?.[question.correctAnswer],
                isCorrect,
                topic: question.topic || "General",
                weight // (optional but useful for debugging)
            });
        }

        const percentage = totalWeight > 0
        ? Math.round((weightedScore / totalWeight) * 100)
        : 0;

        const topicPerformance = {};

        detailedResponses.forEach(r => {
            if (!topicPerformance[r.topic]) {
                topicPerformance[r.topic] = { total: 0, correct: 0 };
            }
            topicPerformance[r.topic].total++;
            if (r.isCorrect) topicPerformance[r.topic].correct++;
        });

        for (let topic in topicPerformance) {
            const t = topicPerformance[topic];
            t.percentage = Math.round((t.correct / t.total) * 100);
        }

        res.json({
            studentName: student.full_name,
            results: [{
                assessmentId: sa.assessment_id,
                assessmentTitle: sa.title,
                completedDate: sa.end_time,
                score: weightedScore,
                maxScore: totalWeight,
                percentage,
                passScore: sa.pass_score,
                timeSpent: sa.time_spent,
                topicPerformance,
                responses: detailedResponses
            }]
        });

    } catch (error) {
        console.error("Error fetching detailed results:", error);
        res.status(500).json({ message: "Server error while fetching results" });
    }
};

exports.saveAssessmentResult = async (req, res, pool) => {
    try {
        const { studentId: studentIdentifier, assessmentId, studentName, responses, percentage, passed, timeUsed } = req.body;

        if (!studentIdentifier || !assessmentId || !studentName || !responses || percentage === undefined || passed === undefined || timeUsed === undefined) {
            return res.status(400).json({ success: false, message: 'Missing required result data.' });
        }

        const studentResult = await pool.query('SELECT id FROM students WHERE student_id = $1', [studentIdentifier]);
        if (studentResult.rows.length === 0) return res.status(404).json({ success: false, message: `Student with identifier ${studentIdentifier} not found.` });
        const studentUUID = studentResult.rows[0].id;

        const assessmentResult = await pool.query('SELECT code FROM assessments WHERE id = $1', [assessmentId]);
        if (assessmentResult.rows.length === 0) return res.status(404).json({ success: false, message: 'Assessment not found.' });
        const assessmentCode = assessmentResult.rows[0].code;

        await createAssessmentResultsTable(pool, assessmentCode);
        const resultsTableName = getResultsTableName(assessmentCode);

        const insertQuery = format(
            'INSERT INTO %I (id, student_uuid, student_identifier, student_name, assessment_id, score_percentage, passed, time_spent_seconds, responses) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            resultsTableName
        );
        const queryParams = [
            uuidv4(), studentUUID, studentIdentifier, studentName, assessmentId, percentage, passed, timeUsed, JSON.stringify(responses)
        ];

        await pool.query(insertQuery, queryParams);
        console.log(`Results saved to dedicated table '${resultsTableName}'`);

        await pool.query(
            `UPDATE student_assessments SET end_time = CURRENT_TIMESTAMP, completed = true, answers = $1, score = $2, time_spent = $3 WHERE student_id = $4 AND assessment_id = $5 AND completed = false`,
            [JSON.stringify(responses), percentage, timeUsed, studentUUID, assessmentId]
        );

        res.status(200).json({ success: true, message: 'Results saved successfully.' });

    } catch (error) {
        console.error('Error saving assessment results:', error);
        res.status(500).json({ success: false, message: 'Server error while saving results.', error: error.message });
    }
};
