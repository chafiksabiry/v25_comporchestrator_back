import express from 'express';
import { escrowController } from '../controllers/escrowController.js';

const router = express.Router();

router.get('/wallet/:companyId', escrowController.getWallet);
router.get('/transactions/:companyId', escrowController.getTransactions);
router.post('/deposit', escrowController.deposit);
router.post('/withdraw', escrowController.withdraw);
router.post('/lock', escrowController.lockFunds);
router.post('/release/:contractId', escrowController.releaseFunds);
router.post('/refund/:contractId', escrowController.refundFunds);

export const escrowRoutes = router;
