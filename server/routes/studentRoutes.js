const express = require('express');
const router = express.Router();
const studentController = require('../controllers/studentController');

module.exports = (pool) => {
    router.get('/admin/student/:id', (req, res) => studentController.getStudentById(req, res, pool));
    router.put('/admin/student/:id', (req, res) => studentController.updateStudent(req, res, pool));
    router.get('/student/:studentId/results', (req, res) => studentController.getStudentResults(req, res, pool));

    // Results saving is strictly speaking an assessment action but handled by student context often.
    // However, the original path was /api/results/save. We can map it here or in assessment routes.
    // The plan said /api/results/save -> studentController? Actually plan didn't specify exactly, 
    // but logic is in studentController.js. Let's expose it here or via a dedicated path in server.js 
    // mapped to this controller. Let's put it here for now under a generic 'results' route if needed,
    // OR keep the /api/results/save path in server.js delegation. 
    // For clarity, I will put it in assessmentRoutes or here? 
    // It's a "Result" operation. Let's keep it here but the path in server.js will need to match or be efficient.
    // Actually, `server.js` usually mounts `app.use('/api', studentRoutes)` etc.
    // So if I mount this router at `/api`, then `/results/save` works.
    router.post('/results/save', (req, res) => studentController.saveAssessmentResult(req, res, pool));
    router.get('/student/:studentId/results/all', (req, res) =>studentController.getAllResults(req, res, pool));
    return router;
};
