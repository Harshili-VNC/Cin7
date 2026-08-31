// DEPRECATED - Destination routes have been replaced by the secure tokenized /api/editor routes.
// Direct file downloads and fake HTML spreadsheet viewers have been removed in accordance with SaaS architecture requirements.

const express = require('express');
const router = express.Router();

router.all('*', (req, res) => {
  res.status(410).json({
    error: 'ENDPOINT_DEPRECATED',
    message: 'Destination endpoints have been deprecated. Use the integrated browser spreadsheet editor.'
  });
});

module.exports = router;