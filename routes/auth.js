const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'auth route placeholder' });
});

module.exports = router;
