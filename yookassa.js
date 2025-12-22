/**
 * YooKassa интеграция для potolki-bot
 * Shop ID: 1222788
 */

const axios = require('axios');

const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '1222788';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;
const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3';

// Базовая авторизация для YooKassa
const getAuthHeader = () => {
  const credentials = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
  return `Basic ${credentials}`;
};

/**
 * Создать платёж в YooKassa
 * @param {number} amount - Сумма в рублях
 * @param {string} description - Описание платежа
 * @param {string} returnUrl - URL для возврата после оплаты
 * @param {object} metadata - Дополнительные данные (payment_id, user_id, etc)
 */
async function createYooKassaPayment(amount, description, returnUrl, metadata = {}) {
  const idempotenceKey = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    const response = await axios.post(
      `${YOOKASSA_API_URL}/payments`,
      {
        amount: {
          value: amount.toFixed(2),
          currency: 'RUB'
        },
        confirmation: {
          type: 'redirect',
          return_url: returnUrl
        },
        capture: true,
        description: description,
        metadata: metadata
      },
      {
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type': 'application/json',
          'Idempotence-Key': idempotenceKey
        }
      }
    );

    return {
      success: true,
      paymentId: response.data.id,
      confirmationUrl: response.data.confirmation.confirmation_url,
      status: response.data.status
    };
  } catch (error) {
    console.error('YooKassa payment error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.description || error.message
    };
  }
}

/**
 * Получить статус платежа
 * @param {string} paymentId - ID платежа в YooKassa
 */
async function getYooKassaPaymentStatus(paymentId) {
  try {
    const response = await axios.get(
      `${YOOKASSA_API_URL}/payments/${paymentId}`,
      {
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      success: true,
      status: response.data.status,
      paid: response.data.paid,
      amount: parseFloat(response.data.amount.value),
      paymentMethod: response.data.payment_method?.type,
      metadata: response.data.metadata
    };
  } catch (error) {
    console.error('YooKassa status error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.description || error.message
    };
  }
}

/**
 * Обработка webhook от YooKassa
 * @param {object} body - Тело запроса от YooKassa
 */
function parseYooKassaWebhook(body) {
  if (!body || !body.event || !body.object) {
    return null;
  }

  const { event, object } = body;

  return {
    event: event, // payment.succeeded, payment.canceled, etc
    paymentId: object.id,
    status: object.status,
    paid: object.paid,
    amount: parseFloat(object.amount?.value || 0),
    metadata: object.metadata || {}
  };
}

/**
 * Предопределённые суммы пополнения (кратные 150)
 */
const TOPUP_AMOUNTS = [
  { amount: 300, label: '300 ₽ (2 генерации)' },
  { amount: 750, label: '750 ₽ (5 генераций)' },
  { amount: 1500, label: '1500 ₽ (10 генераций)' },
  { amount: 3000, label: '3000 ₽ (20 генераций)' },
  { amount: 7500, label: '7500 ₽ (50 генераций)' },
  { amount: 15000, label: '15000 ₽ (100 генераций)' }
];

module.exports = {
  YOOKASSA_SHOP_ID,
  createYooKassaPayment,
  getYooKassaPaymentStatus,
  parseYooKassaWebhook,
  TOPUP_AMOUNTS
};
