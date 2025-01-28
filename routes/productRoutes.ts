const express = require('express');
const { signQRCodeBatch, scanQRCodeUnified, downloadBatchZip, getScanHistory, scanQRCodeSeller } = require('../controllers/productController');
const router = express.Router();

// Route for signing a batch of QR codes and generating a master QR code
router.post('/sign', signQRCodeBatch);

// Route for scanning individual product or master QR codes (consumer)
router.post('/scan', scanQRCodeUnified);

// Route for seller scanning
router.post('/seller-scan', scanQRCodeSeller);

router.get('/batch/:batchId/download', downloadBatchZip);

router.get('/scan-history', getScanHistory);

module.exports = router;