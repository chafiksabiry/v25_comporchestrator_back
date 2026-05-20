import MinutesCompany from '../models/MinutesCompany.js';
import WalletCompany from '../models/WalletCompany.js';
import WalletCompanyEntry from '../models/WalletCompanyEntry.js';

export async function fulfillWalletDeposit(payment) {
  const euros = Number((payment.amount / 100).toFixed(2));

  let wallet = await WalletCompany.findOne({ companyId: payment.companyId });
  if (!wallet) {
    wallet = new WalletCompany({ companyId: payment.companyId, balance: 0 });
  }
  wallet.balance = Number((wallet.balance + euros).toFixed(2));
  await wallet.save();

  try {
    await WalletCompanyEntry.create({
      companyId: payment.companyId,
      type: 'deposit',
      direction: 'credit',
      amount: euros,
      balanceAfter: wallet.balance,
      status: 'completed',
      description: `Dépôt de ${euros.toFixed(2)} € via ${payment.provider}`,
      meta: {
        method: payment.provider,
        providerRef: payment.providerRef || null,
        paymentId: payment._id
      }
    });
  } catch (logErr) {
    console.warn('WalletCompanyEntry log failed (PayPal deposit):', logErr.message);
  }

  return { balance: wallet.balance, credited: euros };
}

export async function fulfillMinutesPurchase(payment) {
  const minutes = Number(payment.quantity || 0);
  if (minutes <= 0) {
    throw new Error('Invalid minutes quantity on payment');
  }

  let wallet = await MinutesCompany.findOne({ companyId: payment.companyId });
  if (!wallet) {
    wallet = new MinutesCompany({ companyId: payment.companyId, minutes: 0 });
  }
  wallet.minutes = Number((wallet.minutes + minutes).toFixed(2));
  wallet.purchasedMinutes = Number(((wallet.purchasedMinutes || 0) + minutes).toFixed(2));
  await wallet.save();

  return {
    minutes: wallet.minutes,
    purchasedMinutes: wallet.purchasedMinutes,
    credited: minutes
  };
}
