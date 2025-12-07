require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const Replicate = require('replicate');
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const ADMIN_IDS = process.env.ADMIN_IDS?.split(',').map(id => parseInt(id.trim())) || [];

const DATA_FILE = path.join(__dirname, 'data.json');
const GENERATION_COST = 75; // 75 RUB за генерацию, маржа ~94%

// ============ БАЗА ДАННЫХ ============

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e);
  }
  return { users: {}, companies: {}, transactions: [], generations: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getUser(userId) {
  const data = loadData();
  return data.users[userId] || null;
}

function createUser(userId, companyId, name) {
  const data = loadData();
  data.users[userId] = {
    id: userId,
    companyId,
    name,
    balance: 0,
    blocked: false,
    createdAt: new Date().toISOString()
  };
  saveData(data);
  return data.users[userId];
}

function updateUser(userId, updates) {
  const data = loadData();
  if (data.users[userId]) {
    Object.assign(data.users[userId], updates);
    saveData(data);
  }
}

function deleteUser(userId) {
  const data = loadData();
  delete data.users[userId];
  saveData(data);
}

function addTransaction(userId, amount, type, description) {
  const data = loadData();
  const tx = {
    id: Date.now(),
    userId,
    amount,
    type,
    description,
    createdAt: new Date().toISOString()
  };
  data.transactions.push(tx);
  saveData(data);
  return tx;
}

function addGeneration(userId, config) {
  const data = loadData();
  const gen = {
    id: Date.now(),
    userId,
    config,
    cost: GENERATION_COST,
    createdAt: new Date().toISOString()
  };
  data.generations.push(gen);
  saveData(data);
  return gen;
}

function getAllUsers() {
  return loadData().users;
}

function getAllTransactions() {
  return loadData().transactions;
}

function getAllGenerations() {
  return loadData().generations;
}

function getCompanies() {
  return loadData().companies;
}

function getCompany(companyId) {
  return loadData().companies[companyId];
}

function addCompany(name) {
  const data = loadData();
  const id = Date.now().toString();
  data.companies[id] = {
    id,
    name,
    createdAt: new Date().toISOString()
  };
  saveData(data);
  return data.companies[id];
}

function deleteCompany(companyId) {
  const data = loadData();
  delete data.companies[companyId];
  saveData(data);
}

function updateCompany(companyId, updates) {
  const data = loadData();
  if (data.companies[companyId]) {
    Object.assign(data.companies[companyId], updates);
    saveData(data);
  }
}

function getUserGenerations(userId) {
  const data = loadData();
  return (data.generations || []).filter(g => g.userId == userId);
}

function getUserTransactions(userId) {
  const data = loadData();
  return (data.transactions || []).filter(t => t.userId == userId);
}

function getCompanyUsers(companyId) {
  const users = getAllUsers();
  return Object.values(users).filter(u => u.companyId === companyId);
}

// Заявки на доступ
function getAccessRequests() {
  const data = loadData();
  return data.accessRequests || [];
}

function addAccessRequest(userId, username, firstName, lastName) {
  const data = loadData();
  if (!data.accessRequests) data.accessRequests = [];

  // Проверяем, нет ли уже заявки
  if (data.accessRequests.find(r => r.userId === userId)) {
    return null;
  }

  const request = {
    id: Date.now(),
    userId,
    username,
    firstName,
    lastName,
    createdAt: new Date().toISOString()
  };
  data.accessRequests.push(request);
  saveData(data);
  return request;
}

function deleteAccessRequest(requestId) {
  const data = loadData();
  data.accessRequests = (data.accessRequests || []).filter(r => r.id !== requestId);
  saveData(data);
}

// ============ СОСТОЯНИЯ ============

const userStates = new Map();

function getState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      photo: null,
      processing: false,
      config: getDefaultConfig(),
      step: null,
      tempData: {}
    });
  }
  return userStates.get(userId);
}

function getDefaultConfig() {
  return {
    color: 'white',
    texture: 'matte',
    profile: { back: 'none', front: 'none', left: 'none', right: 'none' },
    spots: { enabled: false, count: 6, type: 'round', color: 'white' },
    chandelier: { enabled: false, style: 'modern' },
    lightlines: { enabled: false, count: 1, direction: 'along', shape: 'straight' },
    track: { enabled: false, color: 'black' },
    ledStrip: { enabled: false, color: 'warm' },
    niche: false,
    twoLevel: false
  };
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// ============ ПРОМПТЫ ============

const PROMPT_DETAILS = {
  colors: {
    white: 'pure bright white color',
    ivory: 'warm ivory cream white color',
    beige: 'warm beige sand color',
    gray: 'light cool gray color',
    darkgray: 'dark charcoal gray color',
    black: 'deep matte black color',
    blue: 'soft sky blue color',
    pink: 'delicate blush pink color'
  },
  textures: {
    matte: 'smooth matte flat surface with zero reflections, no shine',
    glossy: 'high-gloss lacquered mirror-like surface that reflects the room',
    satin: 'satin pearl finish with soft subtle sheen',
    metallic: 'metallic shimmering finish with sparkle effect'
  },
  profiles: {
    none: null,
    shadow: 'visible black shadow gap (10mm thin dark line where ceiling meets wall)',
    floating: 'LED perimeter lighting (warm white light strip glowing from gap between ceiling and wall)'
  },
  spots: {
    types: {
      round: 'small round recessed LED downlight (5-7cm diameter)',
      square: 'square recessed LED downlight (7x7cm)',
      double: 'twin double-head adjustable spotlight',
      gimbal: 'adjustable gimbal recessed spotlight'
    },
    colors: { white: 'white housing', black: 'black housing', gold: 'gold housing', chrome: 'chrome housing' }
  },
  chandeliers: {
    modern: 'modern minimalist pendant light',
    classic: 'classic elegant chandelier with lampshades',
    crystal: 'luxury crystal chandelier with glass drops',
    minimalist: 'ultra-minimalist thin LED pendant',
    sputnik: 'mid-century sputnik chandelier',
    ring: 'contemporary LED ring chandelier',
    cluster: 'cluster pendant with glass globes',
    industrial: 'industrial style pendant with metal frame'
  },
  lightlines: {
    directions: { along: 'running lengthwise', across: 'running across width', diagonal: 'running diagonally' },
    shapes: { straight: 'straight linear LED light channel', geometric: 'geometric pattern of LED lines', curved: 'curved flowing LED light line' }
  },
  track: {
    black: 'black magnetic track rail system with adjustable spotlights',
    white: 'white magnetic track rail system with adjustable spotlights'
  }
};

function buildPrompt(config) {
  const parts = [];
  parts.push('Edit this room photo. Replace ONLY the ceiling. Do not change walls, floor, furniture, windows, doors.');

  const color = PROMPT_DETAILS.colors[config.color] || PROMPT_DETAILS.colors.white;
  const texture = PROMPT_DETAILS.textures[config.texture] || PROMPT_DETAILS.textures.matte;

  if (config.twoLevel) {
    parts.push(`Install two-level stretch ceiling: ${color}, ${texture}. Gypsum board frame around perimeter.`);
  } else {
    parts.push(`Install flat stretch ceiling: ${color}, ${texture}.`);
  }

  // Профили - упрощенное описание
  const shadowWalls = [];
  const floatingWalls = [];

  for (const [wall, type] of Object.entries(config.profile)) {
    if (type === 'shadow') shadowWalls.push(wall);
    else if (type === 'floating') floatingWalls.push(wall);
  }

  if (shadowWalls.length > 0 || floatingWalls.length > 0) {
    if (shadowWalls.length > 0) {
      parts.push(`Black shadow gap (thin dark 10mm line) where ceiling meets ${shadowWalls.length === 4 ? 'all walls' : shadowWalls.length + ' wall(s)'}.`);
    }
    if (floatingWalls.length > 0) {
      parts.push(`Floating ceiling effect with hidden LED strip (warm white glow) on ${floatingWalls.length === 4 ? 'all walls' : floatingWalls.length + ' wall(s)'}.`);
    }
  }

  // Споты - описываем через сетку для лучшего понимания моделью
  if (config.spots.enabled && config.spots.count > 0) {
    const spotType = PROMPT_DETAILS.spots.types[config.spots.type] || PROMPT_DETAILS.spots.types.round;
    const spotColor = PROMPT_DETAILS.spots.colors[config.spots.color] || '';

    // Преобразуем количество в сетку rows x cols
    let gridDesc;
    switch (config.spots.count) {
      case 1: gridDesc = 'single spotlight in center (1 total)'; break;
      case 2: gridDesc = '1 row x 2 columns (2 total)'; break;
      case 4: gridDesc = '2 rows x 2 columns (4 total)'; break;
      case 6: gridDesc = '2 rows x 3 columns (6 total)'; break;
      case 8: gridDesc = '2 rows x 4 columns (8 total)'; break;
      case 10: gridDesc = '2 rows x 5 columns (10 total)'; break;
      case 12: gridDesc = '3 rows x 4 columns (12 total)'; break;
      case 16: gridDesc = '4 rows x 4 columns (16 total)'; break;
      default: gridDesc = `${config.spots.count} spotlights evenly spaced`; break;
    }

    parts.push(`${spotType} with ${spotColor} arranged in grid: ${gridDesc}, all lights ON, small 5cm diameter each.`);
  }

  if (config.chandelier.enabled) {
    const style = PROMPT_DETAILS.chandeliers[config.chandelier.style] || PROMPT_DETAILS.chandeliers.modern;
    parts.push(`One ${style} in ceiling center.`);
  }

  if (config.lightlines.enabled && config.lightlines.count > 0) {
    const direction = PROMPT_DETAILS.lightlines.directions[config.lightlines.direction];
    const shape = PROMPT_DETAILS.lightlines.shapes[config.lightlines.shape];
    parts.push(`${config.lightlines.count} ${shape} ${direction}, white light.`);
  }

  if (config.track.enabled) {
    parts.push(`${PROMPT_DETAILS.track[config.track.color]}.`);
  }

  if (config.ledStrip.enabled) {
    const ledColor = config.ledStrip.color === 'warm' ? 'warm white' : config.ledStrip.color === 'cold' ? 'cool white' : 'RGB color';
    parts.push(`Hidden ${ledColor} LED strip around entire ceiling perimeter.`);
  }

  if (config.niche) {
    parts.push('Recessed curtain niche at window wall.');
  }

  parts.push('Photorealistic result, same room perspective.');
  return parts.join(' ');
}

// ============ СВОДКА ============

function buildSummary(config) {
  const colors = { white: '⬜ Белый', ivory: '🤍 Айвори', beige: '🟨 Бежевый', gray: '⬛ Серый', darkgray: '🖤 Тёмно-серый', black: '⚫ Чёрный', blue: '🔵 Голубой', pink: '🩷 Розовый' };
  const textures = { matte: 'Матовый', glossy: 'Глянцевый', satin: 'Сатиновый', metallic: 'Металлик' };
  const profiles = { none: '—', shadow: 'Теневой', floating: 'Парящий' };

  const lines = [];
  lines.push(`🎨 ${colors[config.color] || 'Белый'} • ${textures[config.texture] || 'Матовый'}`);
  if (config.twoLevel) lines.push(`🏗 Двухуровневый`);

  const activeProfiles = Object.entries(config.profile).filter(([,v]) => v !== 'none');
  if (activeProfiles.length > 0) {
    const wallNames = { back: 'зад', front: 'перед', left: 'лево', right: 'право' };
    const profileStr = activeProfiles.map(([w, p]) => `${wallNames[w]}: ${profiles[p]}`).join(', ');
    lines.push(`📐 ${profileStr}`);
  }

  const lighting = [];
  if (config.spots.enabled) lighting.push(`💡 ${config.spots.count} спотов`);
  if (config.chandelier.enabled) lighting.push(`🪔 Люстра`);
  if (config.lightlines.enabled) lighting.push(`📏 ${config.lightlines.count} линий`);
  if (config.track.enabled) lighting.push(`🔦 Трек`);
  if (config.ledStrip.enabled) lighting.push(`💫 LED`);
  if (lighting.length > 0) lines.push(lighting.join(' • '));
  if (config.niche) lines.push(`🪟 Ниша для штор`);

  return lines.join('\n');
}

// ============ ГЛАВНОЕ МЕНЮ ============

function mainMenuKeyboard(userId) {
  const user = getUser(userId);
  const buttons = [];

  if (isAdmin(userId)) {
    buttons.push([Markup.button.callback('📸 Новая визуализация', 'new_visual')]);
    buttons.push([Markup.button.callback('👑 Админ-панель', 'admin')]);
  } else if (user) {
    buttons.push([Markup.button.callback('📸 Новая визуализация', 'new_visual')]);
    buttons.push([Markup.button.callback('💰 Баланс: ' + (user.balance || 0) + ' ₽', 'balance')]);
  }

  return Markup.inlineKeyboard(buttons);
}

// ============ КОМАНДА START ============

bot.command('start', ctx => {
  const userId = ctx.from.id;
  const user = getUser(userId);

  let text = '🏠 *Визуализация натяжных потолков*\n\n';

  if (isAdmin(userId)) {
    text += '👑 Вы администратор\n\n';
    text += 'Используйте админ-панель для управления.';
  } else if (user) {
    const company = getCompany(user.companyId);
    text += `🏢 ${company?.name || 'Компания'}\n`;
    text += `💰 Баланс: ${user.balance} ₽\n\n`;
    text += 'Отправьте фото для визуализации.';
  } else {
    // Проверяем, есть ли уже заявка
    const requests = getAccessRequests();
    const hasRequest = requests.find(r => r.userId === userId);

    if (hasRequest) {
      text += '⏳ Ваша заявка на рассмотрении.\n\n';
      text += 'Ожидайте подтверждения администратора.';
      ctx.reply(text, { parse_mode: 'Markdown' });
    } else {
      text += '⚠️ У вас нет доступа.\n\n';
      text += 'Нажмите кнопку ниже, чтобы отправить запрос на получение доступа.';
      ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('📝 Запросить доступ', 'request_access')]])
      });
    }
    return;
  }

  ctx.reply(text, { parse_mode: 'Markdown', ...mainMenuKeyboard(userId) });
});

// ============ ЗАПРОС ДОСТУПА ============

bot.action('request_access', async ctx => {
  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || '';
  const lastName = ctx.from.last_name || '';

  const request = addAccessRequest(userId, username, firstName, lastName);

  if (!request) {
    await ctx.answerCbQuery('Заявка уже отправлена');
    return;
  }

  await ctx.answerCbQuery('Заявка отправлена!');
  await ctx.editMessageText(
    '🏠 *Визуализация натяжных потолков*\n\n' +
    '✅ Заявка отправлена!\n\n' +
    'Ожидайте подтверждения администратора.',
    { parse_mode: 'Markdown' }
  );

  // Уведомляем админов
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'Без имени';
  const userLink = username ? `@${username}` : `ID: ${userId}`;

  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId,
        `📋 *Новая заявка на доступ*\n\n` +
        `👤 ${displayName}\n` +
        `📱 ${userLink}\n` +
        `🆔 \`${userId}\``,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('👀 Посмотреть заявки', 'admin_requests')]])
        }
      );
    } catch (e) {}
  }
});

// ============ БАЛАНС ============

bot.action('balance', async ctx => {
  const userId = ctx.from.id;
  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Нет доступа');

  await ctx.answerCbQuery();

  await ctx.editMessageText(
    `💰 *Ваш баланс: ${user.balance} ₽*\n\n` +
    `📊 Стоимость генерации: ${GENERATION_COST} ₽\n` +
    `🖼 Доступно генераций: ${Math.floor(user.balance / GENERATION_COST)}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📜 История', 'history')],
        [Markup.button.callback('⬅️ Назад', 'back_main')]
      ])
    }
  );
});

bot.action('history', async ctx => {
  const userId = ctx.from.id;
  const transactions = getAllTransactions().filter(t => t.userId == userId).slice(-10).reverse();

  let text = '📜 *История операций*\n\n';
  if (transactions.length === 0) {
    text += 'Пока нет операций';
  } else {
    transactions.forEach(t => {
      const sign = t.amount >= 0 ? '+' : '';
      const date = new Date(t.createdAt).toLocaleDateString('ru-RU');
      text += `${sign}${t.amount} ₽ — ${t.description} (${date})\n`;
    });
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'balance')]])
  });
});

// ============ АДМИН-ПАНЕЛЬ ============

bot.action('admin', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const data = loadData();
  const usersCount = Object.keys(data.users).length;
  const blockedCount = Object.values(data.users).filter(u => u.blocked).length;
  const companiesCount = Object.keys(data.companies).length;
  const totalBalance = Object.values(data.users).reduce((sum, u) => sum + (u.balance || 0), 0);
  const genCount = data.generations?.length || 0;
  const requestsCount = getAccessRequests().length;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '👑 *Админ-панель*\n\n' +
    `🏢 Компаний: ${companiesCount}\n` +
    `👥 Пользователей: ${usersCount}` + (blockedCount > 0 ? ` (🚫 ${blockedCount})` : '') + '\n' +
    `💰 Баланс на счетах: ${totalBalance} ₽\n` +
    `🖼 Всего генераций: ${genCount}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏢 Компании', 'admin_companies'), Markup.button.callback('👥 Все пользователи', 'admin_all_users')],
        [Markup.button.callback(`📋 Заявки (${requestsCount})`, 'admin_requests')],
        [Markup.button.callback('📊 Статистика', 'admin_stats'), Markup.button.callback('💳 Транзакции', 'admin_transactions')],
        [Markup.button.callback('⬅️ Назад', 'back_main')]
      ])
    }
  );
});

// ============ ВСЕ ПОЛЬЗОВАТЕЛИ ============

bot.action('admin_all_users', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const users = Object.values(getAllUsers());
  const companies = getCompanies();

  if (users.length === 0) {
    await ctx.answerCbQuery();
    await ctx.editMessageText('👥 *Все пользователи*\n\nНет пользователей', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
    return;
  }

  // Сортируем: сначала активные, потом заблокированные
  users.sort((a, b) => {
    if (a.blocked && !b.blocked) return 1;
    if (!a.blocked && b.blocked) return -1;
    return (b.balance || 0) - (a.balance || 0);
  });

  const buttons = users.slice(0, 15).map(u => {
    const company = companies[u.companyId];
    const status = u.blocked ? '🚫' : '✅';
    const name = u.name || 'ID:' + u.id;
    return [Markup.button.callback(`${status} ${name} (${u.balance}₽)`, `admin_user_${u.id}`)];
  });

  if (users.length > 15) {
    buttons.push([Markup.button.callback(`... ещё ${users.length - 15} пользователей`, 'admin_all_users_more')]);
  }

  buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(`👥 *Все пользователи (${users.length})*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Детальный просмотр пользователя (расширенный)
bot.action(/^admin_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const company = getCompany(user.companyId);
  const gens = getUserGenerations(userId);
  const txs = getUserTransactions(userId);
  const totalSpent = txs.filter(t => t.type === 'generation').reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const regDate = new Date(user.createdAt).toLocaleDateString('ru-RU');

  let text = `👤 *${user.name || 'Без имени'}*\n\n`;
  text += `🆔 ID: \`${userId}\`\n`;
  text += `🏢 Компания: ${company?.name || '—'}\n`;
  text += `💰 Баланс: ${user.balance} ₽\n`;
  text += `🖼 Генераций: ${gens.length}\n`;
  text += `💸 Потрачено: ${totalSpent} ₽\n`;
  text += `📅 Регистрация: ${regDate}\n`;
  text += `📊 Статус: ${user.blocked ? '🚫 Заблокирован' : '✅ Активен'}`;

  const buttons = [
    [Markup.button.callback('💳 Пополнить', `topup_user_${userId}`), Markup.button.callback('💸 Списать', `deduct_user_${userId}`)],
    [Markup.button.callback(user.blocked ? '✅ Разблокировать' : '🚫 Заблокировать', `toggle_block_${userId}`)],
    [Markup.button.callback('🔄 Сменить компанию', `change_company_${userId}`)],
    [Markup.button.callback('📜 История операций', `user_history_${userId}`)],
    [Markup.button.callback('🗑 Удалить', `confirm_delete_user_${userId}`)],
    [Markup.button.callback('⬅️ Назад', 'admin_all_users')]
  ];

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Блокировка/разблокировка
bot.action(/^toggle_block_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const newStatus = !user.blocked;
  updateUser(userId, { blocked: newStatus });

  // Уведомляем пользователя
  try {
    if (newStatus) {
      await bot.telegram.sendMessage(userId, '🚫 Ваш доступ заблокирован администратором.');
    } else {
      await bot.telegram.sendMessage(userId, '✅ Ваш доступ восстановлен.');
    }
  } catch (e) {}

  await ctx.answerCbQuery(newStatus ? 'Заблокирован' : 'Разблокирован');

  // Обновляем экран
  const company = getCompany(user.companyId);
  const gens = getUserGenerations(userId);
  const txs = getUserTransactions(userId);
  const totalSpent = txs.filter(t => t.type === 'generation').reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const regDate = new Date(user.createdAt).toLocaleDateString('ru-RU');

  let text = `👤 *${user.name || 'Без имени'}*\n\n`;
  text += `🆔 ID: \`${userId}\`\n`;
  text += `🏢 Компания: ${company?.name || '—'}\n`;
  text += `💰 Баланс: ${user.balance} ₽\n`;
  text += `🖼 Генераций: ${gens.length}\n`;
  text += `💸 Потрачено: ${totalSpent} ₽\n`;
  text += `📅 Регистрация: ${regDate}\n`;
  text += `📊 Статус: ${newStatus ? '🚫 Заблокирован' : '✅ Активен'}`;

  const buttons = [
    [Markup.button.callback('💳 Пополнить', `topup_user_${userId}`), Markup.button.callback('💸 Списать', `deduct_user_${userId}`)],
    [Markup.button.callback(newStatus ? '✅ Разблокировать' : '🚫 Заблокировать', `toggle_block_${userId}`)],
    [Markup.button.callback('🔄 Сменить компанию', `change_company_${userId}`)],
    [Markup.button.callback('📜 История операций', `user_history_${userId}`)],
    [Markup.button.callback('🗑 Удалить', `confirm_delete_user_${userId}`)],
    [Markup.button.callback('⬅️ Назад', 'admin_all_users')]
  ];

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Списание с баланса
bot.action(/^deduct_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const state = getState(ctx.from.id);
  state.tempData.deductUserId = userId;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `💸 *Списание с баланса*\n\n` +
    `👤 ${user.name || 'ID:' + userId}\n` +
    `💰 Текущий баланс: ${user.balance} ₽\n\n` +
    `Выберите сумму списания:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('100 ₽', 'do_deduct_100'), Markup.button.callback('500 ₽', 'do_deduct_500')],
        [Markup.button.callback('1000 ₽', 'do_deduct_1000'), Markup.button.callback('Весь баланс', `do_deduct_${user.balance}`)],
        [Markup.button.callback('⬅️ Назад', `admin_user_${userId}`)]
      ])
    }
  );
});

bot.action(/^do_deduct_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const state = getState(ctx.from.id);
  const amount = parseInt(ctx.match[1]);
  const userId = state.tempData.deductUserId;

  if (!userId) return ctx.answerCbQuery('Ошибка');

  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const deductAmount = Math.min(amount, user.balance);
  if (deductAmount <= 0) return ctx.answerCbQuery('Нечего списывать');

  updateUser(userId, { balance: user.balance - deductAmount });
  addTransaction(userId, -deductAmount, 'deduct', 'Списание администратором');

  try {
    await bot.telegram.sendMessage(userId, `💸 С вашего баланса списано ${deductAmount} ₽\n\nТекущий баланс: ${user.balance - deductAmount} ₽`);
  } catch (e) {}

  state.tempData = {};

  await ctx.answerCbQuery(`Списано ${deductAmount} ₽`);
  await ctx.editMessageText(`✅ Списано ${deductAmount} ₽`, {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К пользователю', `admin_user_${userId}`)]])
  });
});

// Смена компании
bot.action(/^change_company_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const companies = Object.values(getCompanies());

  if (companies.length === 0) {
    return ctx.answerCbQuery('Нет компаний');
  }

  const buttons = companies.map(c => [
    Markup.button.callback(
      (c.id === user.companyId ? '✅ ' : '') + c.name,
      `set_company_${userId}_${c.id}`
    )
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', `admin_user_${userId}`)]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🔄 *Смена компании*\n\n👤 ${user.name}\n\nВыберите новую компанию:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action(/^set_company_(\d+)_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const companyId = ctx.match[2];

  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const company = getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  updateUser(userId, { companyId });

  await ctx.answerCbQuery(`Перемещён в ${company.name}`);
  await ctx.editMessageText(`✅ Пользователь перемещён в "${company.name}"`, {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К пользователю', `admin_user_${userId}`)]])
  });
});

// История операций пользователя
bot.action(/^user_history_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const txs = getUserTransactions(userId).slice(-15).reverse();

  let text = `📜 *История операций*\n\n`;

  if (txs.length === 0) {
    text += 'Нет операций';
  } else {
    txs.forEach(t => {
      const sign = t.amount >= 0 ? '+' : '';
      const date = new Date(t.createdAt).toLocaleDateString('ru-RU');
      text += `${sign}${t.amount} ₽ — ${t.description} (${date})\n`;
    });
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `admin_user_${userId}`)]])
  });
});

// Подтверждение удаления пользователя
bot.action(/^confirm_delete_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🗑 *Удалить пользователя?*\n\n` +
    `👤 ${user.name || 'ID:' + userId}\n` +
    `💰 Баланс: ${user.balance} ₽\n\n` +
    `⚠️ Действие необратимо!`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, удалить', `do_delete_user_${userId}`)],
        [Markup.button.callback('❌ Отмена', `admin_user_${userId}`)]
      ])
    }
  );
});

bot.action(/^do_delete_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  deleteUser(userId);

  await ctx.answerCbQuery('Удалён');
  await ctx.editMessageText('✅ Пользователь удалён', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К пользователям', 'admin_all_users')]])
  });
});

// ============ ТРАНЗАКЦИИ ============

bot.action('admin_transactions', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const txs = getAllTransactions().slice(-20).reverse();
  const users = getAllUsers();

  let text = `💳 *Последние транзакции*\n\n`;

  if (txs.length === 0) {
    text += 'Нет транзакций';
  } else {
    txs.forEach(t => {
      const user = users[t.userId];
      const userName = user?.name || 'ID:' + t.userId;
      const sign = t.amount >= 0 ? '+' : '';
      const date = new Date(t.createdAt).toLocaleDateString('ru-RU');
      const icon = t.type === 'topup' ? '💰' : t.type === 'generation' ? '🖼' : '💸';
      text += `${icon} ${sign}${t.amount}₽ | ${userName} | ${date}\n`;
    });
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
  });
});

// ============ ЗАЯВКИ НА ДОСТУП ============

bot.action('admin_requests', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const requests = getAccessRequests();

  if (requests.length === 0) {
    await ctx.answerCbQuery();
    await ctx.editMessageText('📋 *Заявки на доступ*\n\nНет новых заявок', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
    return;
  }

  const buttons = requests.slice(0, 10).map(r => {
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Без имени';
    const tag = r.username ? `@${r.username}` : '';
    return [Markup.button.callback(`👤 ${name} ${tag}`, `view_request_${r.id}`)];
  });
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(`📋 *Заявки на доступ (${requests.length})*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action(/^view_request_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const requestId = parseInt(ctx.match[1]);
  const requests = getAccessRequests();
  const request = requests.find(r => r.id === requestId);

  if (!request) {
    return ctx.answerCbQuery('Заявка не найдена');
  }

  const name = [request.firstName, request.lastName].filter(Boolean).join(' ') || 'Без имени';
  const userLink = request.username ? `@${request.username}` : `ID: ${request.userId}`;
  const date = new Date(request.createdAt).toLocaleDateString('ru-RU');

  // Получаем список компаний для выбора
  const companies = Object.values(getCompanies());

  const buttons = companies.map(c => [
    Markup.button.callback(`🏢 ${c.name}`, `approve_request_${requestId}_${c.id}`)
  ]);
  buttons.push([Markup.button.callback('❌ Отклонить', `reject_request_${requestId}`)]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin_requests')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `📋 *Заявка*\n\n` +
    `👤 ${name}\n` +
    `📱 ${userLink}\n` +
    `🆔 \`${request.userId}\`\n` +
    `📅 ${date}\n\n` +
    (companies.length > 0 ? 'Выберите компанию:' : '⚠️ Сначала создайте компанию'),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^approve_request_(\d+)_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const requestId = parseInt(ctx.match[1]);
  const companyId = ctx.match[2];

  const requests = getAccessRequests();
  const request = requests.find(r => r.id === requestId);

  if (!request) {
    return ctx.answerCbQuery('Заявка не найдена');
  }

  const company = getCompany(companyId);
  if (!company) {
    return ctx.answerCbQuery('Компания не найдена');
  }

  const name = [request.firstName, request.lastName].filter(Boolean).join(' ') || 'Пользователь';

  // Создаём пользователя
  createUser(request.userId, companyId, name);

  // Удаляем заявку
  deleteAccessRequest(requestId);

  // Уведомляем пользователя
  try {
    await bot.telegram.sendMessage(request.userId,
      `🎉 Ваша заявка одобрена!\n\n` +
      `🏢 Компания: ${company.name}\n\n` +
      `Отправьте /start чтобы начать.`
    );
  } catch (e) {}

  await ctx.answerCbQuery('Одобрено');

  // Возвращаемся к списку заявок
  const remainingRequests = getAccessRequests();
  if (remainingRequests.length === 0) {
    await ctx.editMessageText('📋 *Заявки на доступ*\n\n✅ Все заявки обработаны', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
  } else {
    const buttons = remainingRequests.slice(0, 10).map(r => {
      const n = [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Без имени';
      const tag = r.username ? `@${r.username}` : '';
      return [Markup.button.callback(`👤 ${n} ${tag}`, `view_request_${r.id}`)];
    });
    buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);
    await ctx.editMessageText(`📋 *Заявки на доступ (${remainingRequests.length})*`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  }
});

bot.action(/^reject_request_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const requestId = parseInt(ctx.match[1]);
  const requests = getAccessRequests();
  const request = requests.find(r => r.id === requestId);

  if (!request) {
    return ctx.answerCbQuery('Заявка не найдена');
  }

  // Удаляем заявку
  deleteAccessRequest(requestId);

  // Уведомляем пользователя
  try {
    await bot.telegram.sendMessage(request.userId, '❌ Ваша заявка на доступ отклонена.');
  } catch (e) {}

  await ctx.answerCbQuery('Отклонено');

  // Возвращаемся к списку заявок
  const remainingRequests = getAccessRequests();
  if (remainingRequests.length === 0) {
    await ctx.editMessageText('📋 *Заявки на доступ*\n\nНет новых заявок', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
  } else {
    const buttons = remainingRequests.slice(0, 10).map(r => {
      const n = [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Без имени';
      const tag = r.username ? `@${r.username}` : '';
      return [Markup.button.callback(`👤 ${n} ${tag}`, `view_request_${r.id}`)];
    });
    buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);
    await ctx.editMessageText(`📋 *Заявки на доступ (${remainingRequests.length})*`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  }
});

// ============ КОМПАНИИ ============

bot.action('admin_companies', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companies = Object.values(getCompanies());

  const buttons = companies.slice(0, 10).map(c => {
    const users = getCompanyUsers(c.id);
    const totalBalance = users.reduce((sum, u) => sum + (u.balance || 0), 0);
    return [Markup.button.callback(`🏢 ${c.name} (${users.length} чел, ${totalBalance}₽)`, `company_${c.id}`)];
  });

  buttons.push([Markup.button.callback('➕ Добавить компанию', 'add_company')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText('🏢 *Компании*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('add_company', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const state = getState(ctx.from.id);
  state.step = 'add_company_name';
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🏢 *Новая компания*\n\nВведите название:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_companies')]]) }
  );
});

bot.action(/^company_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companyId = ctx.match[1];
  const company = getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = getCompanyUsers(companyId);
  const totalBalance = users.reduce((sum, u) => sum + (u.balance || 0), 0);

  let text = `🏢 *${company.name}*\n\n`;
  text += `👥 Сотрудников: ${users.length}\n`;
  text += `💰 Общий баланс: ${totalBalance} ₽\n\n`;

  if (users.length > 0) {
    text += '*Сотрудники:*\n';
    users.forEach(u => {
      text += `• ${u.name || 'ID:' + u.id} — ${u.balance}₽\n`;
    });
  }

  const buttons = [
    [Markup.button.callback('➕ Добавить сотрудника', `add_user_${companyId}`)],
    [Markup.button.callback('💳 Пополнить баланс', `topup_company_${companyId}`)],
  ];

  if (users.length > 0) {
    buttons.push([Markup.button.callback('👥 Управление сотрудниками', `manage_users_${companyId}`)]);
    buttons.push([Markup.button.callback('📊 Отчёт по компании', `company_report_${companyId}`)]);
  }

  buttons.push([Markup.button.callback('✏️ Переименовать', `rename_company_${companyId}`)]);
  buttons.push([Markup.button.callback('🗑 Удалить компанию', `delete_company_${companyId}`)]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin_companies')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// ============ ОТЧЁТ ПО КОМПАНИИ ============

bot.action(/^company_report_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companyId = ctx.match[1];
  const company = getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = getCompanyUsers(companyId);
  const allGens = getAllGenerations();
  const allTxs = getAllTransactions();

  // Статистика по компании
  let totalGens = 0;
  let totalSpent = 0;
  let totalTopups = 0;
  let totalBalance = 0;

  const userStats = users.map(u => {
    const userGens = allGens.filter(g => g.userId == u.id);
    const userTxs = allTxs.filter(t => t.userId == u.id);
    const spent = userGens.length * GENERATION_COST;
    const topups = userTxs.filter(t => t.type === 'topup').reduce((sum, t) => sum + t.amount, 0);

    totalGens += userGens.length;
    totalSpent += spent;
    totalTopups += topups;
    totalBalance += u.balance || 0;

    return {
      name: u.name || 'ID:' + u.id,
      balance: u.balance || 0,
      gens: userGens.length,
      spent,
      topups
    };
  });

  let text = `📊 *Отчёт: ${company.name}*\n\n`;
  text += `📅 Дата: ${new Date().toLocaleDateString('ru-RU')}\n\n`;
  text += `*Итого по компании:*\n`;
  text += `👥 Сотрудников: ${users.length}\n`;
  text += `🖼 Генераций: ${totalGens}\n`;
  text += `💸 Расходы: ${totalSpent} ₽\n`;
  text += `💰 Пополнения: ${totalTopups} ₽\n`;
  text += `💳 Остаток на счетах: ${totalBalance} ₽\n\n`;

  if (userStats.length > 0) {
    text += `*По сотрудникам:*\n`;
    userStats.sort((a, b) => b.gens - a.gens);
    userStats.forEach(u => {
      text += `• ${u.name}: ${u.gens} ген. (${u.spent}₽), баланс ${u.balance}₽\n`;
    });
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📤 Отправить руководителю', `send_report_${companyId}`)],
      [Markup.button.callback('⬅️ Назад', `company_${companyId}`)]
    ])
  });
});

// Отправить отчёт руководителю (первому сотруднику компании или ввести ID)
bot.action(/^send_report_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companyId = ctx.match[1];
  const company = getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = getCompanyUsers(companyId);

  if (users.length === 0) {
    return ctx.answerCbQuery('Нет сотрудников');
  }

  const buttons = users.map(u => [
    Markup.button.callback(`📤 ${u.name || 'ID:' + u.id}`, `do_send_report_${companyId}_${u.id}`)
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', `company_report_${companyId}`)]);

  await ctx.answerCbQuery();
  await ctx.editMessageText('📤 *Выберите получателя отчёта:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action(/^do_send_report_(.+)_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companyId = ctx.match[1];
  const recipientId = ctx.match[2];

  const company = getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = getCompanyUsers(companyId);
  const allGens = getAllGenerations();
  const allTxs = getAllTransactions();

  // Формируем отчёт
  let totalGens = 0;
  let totalSpent = 0;
  let totalBalance = 0;

  const userStats = users.map(u => {
    const userGens = allGens.filter(g => g.userId == u.id);
    const spent = userGens.length * GENERATION_COST;

    totalGens += userGens.length;
    totalSpent += spent;
    totalBalance += u.balance || 0;

    return {
      name: u.name || 'ID:' + u.id,
      balance: u.balance || 0,
      gens: userGens.length,
      spent
    };
  });

  let reportText = `📊 *Отчёт: ${company.name}*\n\n`;
  reportText += `📅 ${new Date().toLocaleDateString('ru-RU')}\n\n`;
  reportText += `*Итого:*\n`;
  reportText += `🖼 Генераций: ${totalGens}\n`;
  reportText += `💸 Расходы: ${totalSpent} ₽\n`;
  reportText += `💳 Остаток: ${totalBalance} ₽\n\n`;

  if (userStats.length > 0) {
    reportText += `*По сотрудникам:*\n`;
    userStats.sort((a, b) => b.gens - a.gens);
    userStats.forEach(u => {
      reportText += `• ${u.name}: ${u.gens} ген., ${u.spent}₽\n`;
    });
  }

  try {
    await bot.telegram.sendMessage(recipientId, reportText, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery('Отчёт отправлен!');
    await ctx.editMessageText('✅ Отчёт отправлен!', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К компании', `company_${companyId}`)]])
    });
  } catch (e) {
    await ctx.answerCbQuery('Ошибка отправки');
    await ctx.editMessageText('❌ Не удалось отправить отчёт. Возможно, пользователь не начал диалог с ботом.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `company_report_${companyId}`)]])
    });
  }
});

// ============ ПЕРЕИМЕНОВАНИЕ КОМПАНИИ ============

bot.action(/^rename_company_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companyId = ctx.match[1];
  const company = getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const state = getState(ctx.from.id);
  state.step = 'rename_company';
  state.tempData.renameCompanyId = companyId;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `✏️ *Переименование компании*\n\nТекущее название: ${company.name}\n\nВведите новое название:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `company_${companyId}`)]]) }
  );
});

// ============ ДОБАВЛЕНИЕ СОТРУДНИКА ============

bot.action(/^add_user_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companyId = ctx.match[1];
  const state = getState(ctx.from.id);
  state.step = 'add_user_id';
  state.tempData.companyId = companyId;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '👤 *Добавить сотрудника*\n\n' +
    'Введите Telegram ID пользователя:\n\n' +
    '_Пользователь должен написать боту /start чтобы узнать свой ID, или перешлите сообщение от пользователя_',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `company_${companyId}`)]]) }
  );
});

// ============ УПРАВЛЕНИЕ СОТРУДНИКАМИ ============

bot.action(/^manage_users_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companyId = ctx.match[1];
  const users = getCompanyUsers(companyId);

  const buttons = users.map(u => [
    Markup.button.callback(`${u.name || 'ID:' + u.id} (${u.balance}₽)`, `user_${u.id}`)
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', `company_${companyId}`)]);

  await ctx.answerCbQuery();
  await ctx.editMessageText('👥 *Сотрудники*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const gens = getAllGenerations().filter(g => g.userId == userId).length;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `👤 *${user.name || 'ID:' + userId}*\n\n` +
    `💰 Баланс: ${user.balance} ₽\n` +
    `🖼 Генераций: ${gens}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Пополнить', `topup_user_${userId}`)],
        [Markup.button.callback('🗑 Удалить', `delete_user_${userId}`)],
        [Markup.button.callback('⬅️ Назад', `manage_users_${user.companyId}`)]
      ])
    }
  );
});

bot.action(/^delete_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const companyId = user.companyId;
  deleteUser(userId);

  await ctx.answerCbQuery('Удалён');

  // Возврат к списку сотрудников
  const users = getCompanyUsers(companyId);
  if (users.length === 0) {
    // Если сотрудников не осталось, возвращаемся к компании
    const company = getCompany(companyId);
    await ctx.editMessageText(`🏢 *${company?.name}*\n\nСотрудников нет`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить сотрудника', `add_user_${companyId}`)],
        [Markup.button.callback('⬅️ Назад', 'admin_companies')]
      ])
    });
  } else {
    const buttons = users.map(u => [
      Markup.button.callback(`${u.name || 'ID:' + u.id} (${u.balance}₽)`, `user_${u.id}`)
    ]);
    buttons.push([Markup.button.callback('⬅️ Назад', `company_${companyId}`)]);
    await ctx.editMessageText('👥 *Сотрудники*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  }
});

// ============ ПОПОЛНЕНИЕ БАЛАНСА ============

bot.action(/^topup_company_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companyId = ctx.match[1];
  const users = getCompanyUsers(companyId);

  if (users.length === 0) {
    return ctx.answerCbQuery('Нет сотрудников');
  }

  const buttons = users.map(u => [
    Markup.button.callback(`${u.name || 'ID:' + u.id} (${u.balance}₽)`, `topup_user_${u.id}`)
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', `company_${companyId}`)]);

  await ctx.answerCbQuery();
  await ctx.editMessageText('💳 *Выберите сотрудника:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^topup_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const state = getState(ctx.from.id);
  state.tempData.topupUserId = userId;

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `💳 *Пополнение баланса*\n\n` +
    `👤 ${user.name || 'ID:' + userId}\n` +
    `💰 Текущий баланс: ${user.balance} ₽\n\n` +
    `Выберите сумму:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('500 ₽', 'do_topup_500'), Markup.button.callback('1000 ₽', 'do_topup_1000')],
        [Markup.button.callback('2000 ₽', 'do_topup_2000'), Markup.button.callback('5000 ₽', 'do_topup_5000')],
        [Markup.button.callback('10000 ₽', 'do_topup_10000')],
        [Markup.button.callback('⬅️ Назад', `user_${userId}`)]
      ])
    }
  );
});

bot.action(/^do_topup_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const state = getState(ctx.from.id);
  const amount = parseInt(ctx.match[1]);
  const userId = state.tempData.topupUserId;

  if (!userId) return ctx.answerCbQuery('Ошибка');

  const user = getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  updateUser(userId, { balance: (user.balance || 0) + amount });
  addTransaction(userId, amount, 'topup', 'Пополнение администратором');

  try {
    await bot.telegram.sendMessage(userId, `💰 Ваш баланс пополнен на ${amount} ₽\n\nТекущий баланс: ${user.balance + amount} ₽`);
  } catch (e) {}

  state.tempData = {};

  await ctx.answerCbQuery(`Пополнено на ${amount} ₽`);
  await ctx.editMessageText(`✅ Баланс пополнен на ${amount} ₽`, {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К компаниям', 'admin_companies')]])
  });
});

// ============ УДАЛЕНИЕ КОМПАНИИ ============

bot.action(/^delete_company_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companyId = ctx.match[1];
  const company = getCompany(companyId);
  const users = getCompanyUsers(companyId);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🗑 *Удалить компанию "${company?.name}"?*\n\n` +
    `⚠️ Будут удалены ${users.length} сотрудников!`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, удалить', `confirm_delete_company_${companyId}`)],
        [Markup.button.callback('❌ Отмена', `company_${companyId}`)]
      ])
    }
  );
});

bot.action(/^confirm_delete_company_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const companyId = ctx.match[1];
  const users = getCompanyUsers(companyId);

  // Удаляем всех сотрудников
  users.forEach(u => deleteUser(u.id));
  // Удаляем компанию
  deleteCompany(companyId);

  await ctx.answerCbQuery('Компания удалена');

  // Возврат к списку компаний
  const companies = Object.values(getCompanies());
  const buttons = companies.slice(0, 10).map(c => {
    const cUsers = getCompanyUsers(c.id);
    const totalBalance = cUsers.reduce((sum, u) => sum + (u.balance || 0), 0);
    return [Markup.button.callback(`🏢 ${c.name} (${cUsers.length} чел, ${totalBalance}₽)`, `company_${c.id}`)];
  });
  buttons.push([Markup.button.callback('➕ Добавить компанию', 'add_company')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);

  await ctx.editMessageText('🏢 *Компании*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// ============ СТАТИСТИКА ============

bot.action('admin_stats', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const data = loadData();
  const today = new Date().toISOString().split('T')[0];
  const todayGens = (data.generations || []).filter(g => g.createdAt?.startsWith(today)).length;
  const todayRevenue = (data.transactions || [])
    .filter(t => t.createdAt?.startsWith(today) && t.type === 'topup')
    .reduce((sum, t) => sum + t.amount, 0);

  const totalGens = (data.generations || []).length;
  const totalRevenue = (data.transactions || [])
    .filter(t => t.type === 'topup')
    .reduce((sum, t) => sum + t.amount, 0);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '📊 *Статистика*\n\n' +
    '*Сегодня:*\n' +
    `🖼 Генераций: ${todayGens}\n` +
    `💰 Пополнений: ${todayRevenue} ₽\n\n` +
    '*Всего:*\n' +
    `🖼 Генераций: ${totalGens}\n` +
    `💰 Пополнений: ${totalRevenue} ₽`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    }
  );
});

// ============ ВИЗУАЛИЗАЦИЯ ============

bot.action('new_visual', async ctx => {
  const userId = ctx.from.id;
  const user = getUser(userId);

  if (!isAdmin(userId) && !user) {
    return ctx.answerCbQuery('Нет доступа');
  }

  if (!isAdmin(userId) && user.balance < GENERATION_COST) {
    return ctx.answerCbQuery(`Недостаточно средств. Нужно ${GENERATION_COST} ₽`);
  }

  const state = getState(userId);
  state.photo = null;
  state.config = getDefaultConfig();

  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(
      '📸 *Новая визуализация*\n\nОтправьте фото помещения',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back_main')]]) }
    );
  } catch (e) {
    await ctx.reply(
      '📸 *Новая визуализация*\n\nОтправьте фото помещения',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back_main')]]) }
    );
  }
});

bot.action('back_main', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  state.step = null;
  state.tempData = {};
  await ctx.answerCbQuery();

  const user = getUser(userId);
  let text = '🏠 *Визуализация натяжных потолков*\n\n';

  if (isAdmin(userId)) {
    text += '👑 Вы администратор\n\n';
  } else if (user) {
    const company = getCompany(user.companyId);
    text += `🏢 ${company?.name || 'Компания'}\n`;
    text += `💰 Баланс: ${user.balance} ₽\n\n`;
  }

  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...mainMenuKeyboard(userId) });
  } catch (e) {
    // Если сообщение с фото - отправляем новое
    await ctx.reply(text, { parse_mode: 'Markdown', ...mainMenuKeyboard(userId) });
  }
});

// ============ ЗАГРУЗКА ФОТО ============

bot.on('photo', async ctx => {
  const userId = ctx.from.id;
  const user = getUser(userId);

  if (!isAdmin(userId) && !user) {
    return ctx.reply('⚠️ У вас нет доступа. Обратитесь к администратору.');
  }

  if (!isAdmin(userId) && user.balance < GENERATION_COST) {
    return ctx.reply(`❌ Недостаточно средств. Нужно ${GENERATION_COST} ₽`, mainMenuKeyboard(userId));
  }

  const state = getState(userId);

  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    state.photo = Buffer.from(resp.data);
    state.config = getDefaultConfig();

    await ctx.reply('✅ *Фото загружено*\n\n' + buildSummary(state.config), {
      parse_mode: 'Markdown',
      ...configMenu(state.config)
    });
  } catch (e) {
    console.error(e);
    ctx.reply('❌ Ошибка загрузки фото');
  }
});

// ============ ОБРАБОТКА ТЕКСТА ============

bot.on('text', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const text = ctx.message.text;

  // Добавление компании
  if (state.step === 'add_company_name' && isAdmin(userId)) {
    const company = addCompany(text);
    state.step = null;

    return ctx.reply(`✅ Компания "${text}" создана`,
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить сотрудника', `add_user_${company.id}`)],
        [Markup.button.callback('⬅️ К компаниям', 'admin_companies')]
      ])
    );
  }

  // Переименование компании
  if (state.step === 'rename_company' && isAdmin(userId)) {
    const companyId = state.tempData.renameCompanyId;
    const newName = text.trim();

    updateCompany(companyId, { name: newName });
    state.step = null;
    state.tempData = {};

    return ctx.reply(`✅ Компания переименована в "${newName}"`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ К компании', `company_${companyId}`)]])
    );
  }

  // Добавление сотрудника - ID
  if (state.step === 'add_user_id' && isAdmin(userId)) {
    const newUserId = text.trim();

    if (!/^\d+$/.test(newUserId)) {
      return ctx.reply('❌ ID должен содержать только цифры. Попробуйте снова:');
    }

    if (getUser(newUserId)) {
      return ctx.reply('❌ Этот пользователь уже добавлен. Введите другой ID:');
    }

    state.tempData.newUserId = newUserId;
    state.step = 'add_user_name';

    return ctx.reply('👤 Введите имя сотрудника:');
  }

  // Добавление сотрудника - Имя
  if (state.step === 'add_user_name' && isAdmin(userId)) {
    const newUserId = state.tempData.newUserId;
    const companyId = state.tempData.companyId;
    const name = text.trim();

    createUser(newUserId, companyId, name);

    state.step = null;
    state.tempData = {};

    try {
      const company = getCompany(companyId);
      await bot.telegram.sendMessage(newUserId,
        `🎉 Вам предоставлен доступ к боту визуализации потолков!\n\n` +
        `🏢 Компания: ${company?.name}\n\n` +
        `Отправьте /start чтобы начать.`
      );
    } catch (e) {
      // Пользователь не начал диалог с ботом
    }

    return ctx.reply(`✅ Сотрудник "${name}" добавлен`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ К компании', `company_${companyId}`)]])
    );
  }
});

// Обработка пересланных сообщений для получения ID
bot.on('forward', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);

  if (state.step === 'add_user_id' && isAdmin(userId) && ctx.message.forward_from) {
    const forwardedUserId = ctx.message.forward_from.id.toString();

    if (getUser(forwardedUserId)) {
      return ctx.reply('❌ Этот пользователь уже добавлен.');
    }

    state.tempData.newUserId = forwardedUserId;
    state.step = 'add_user_name';

    const forwardedName = ctx.message.forward_from.first_name || '';
    return ctx.reply(`👤 ID: ${forwardedUserId}\n\nВведите имя сотрудника (или оставьте "${forwardedName}"):`);
  }
});

// ============ МЕНЮ КОНФИГУРАЦИИ ============

function configMenu(config) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎨 Цвет', 'cfg_color'), Markup.button.callback('✨ Текстура', 'cfg_texture')],
    [Markup.button.callback('📐 Профили', 'cfg_profiles'), Markup.button.callback('🏗 Уровни', 'cfg_levels')],
    [Markup.button.callback('💡 Споты', 'cfg_spots'), Markup.button.callback('🪔 Люстра', 'cfg_chandelier')],
    [Markup.button.callback('📏 Линии', 'cfg_lightlines'), Markup.button.callback('🔦 Трек', 'cfg_track')],
    [Markup.button.callback('💫 LED', 'cfg_led'), Markup.button.callback('🪟 Ниша', 'cfg_niche')],
    [Markup.button.callback('✅ Сгенерировать', 'generate')],
    [Markup.button.callback('🔄 Сброс', 'reset'), Markup.button.callback('⬅️ Меню', 'back_main')]
  ]);
}

bot.action('reset', async ctx => {
  const state = getState(ctx.from.id);
  state.config = getDefaultConfig();
  await ctx.answerCbQuery('Сброшено');
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ЦВЕТ ============

bot.action('cfg_color', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🎨 *Цвет потолка:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⬜ Белый', 'color_white'), Markup.button.callback('🤍 Айвори', 'color_ivory')],
      [Markup.button.callback('🟨 Бежевый', 'color_beige'), Markup.button.callback('⬛ Серый', 'color_gray')],
      [Markup.button.callback('🖤 Тёмно-серый', 'color_darkgray'), Markup.button.callback('⚫ Чёрный', 'color_black')],
      [Markup.button.callback('🔵 Голубой', 'color_blue'), Markup.button.callback('🩷 Розовый', 'color_pink')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action(/^color_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.color = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ТЕКСТУРА ============

bot.action('cfg_texture', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('✨ *Текстура:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🎨 Матовый', 'texture_matte')],
      [Markup.button.callback('✨ Глянцевый', 'texture_glossy')],
      [Markup.button.callback('🌟 Сатин', 'texture_satin')],
      [Markup.button.callback('⚡ Металлик', 'texture_metallic')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action(/^texture_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.texture = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ПРОФИЛИ ============

bot.action('cfg_profiles', async ctx => {
  const state = getState(ctx.from.id);
  const p = state.config.profile;
  const icon = (v) => v === 'shadow' ? '🔲' : v === 'floating' ? '💫' : '➖';

  await ctx.answerCbQuery();
  await ctx.editMessageText('📐 *Профили по стенам:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`⬆️ Зад: ${icon(p.back)}`, 'profile_back')],
      [Markup.button.callback(`⬇️ Перед: ${icon(p.front)}`, 'profile_front')],
      [Markup.button.callback(`⬅️ Лево: ${icon(p.left)}`, 'profile_left')],
      [Markup.button.callback(`➡️ Право: ${icon(p.right)}`, 'profile_right')],
      [Markup.button.callback('🔲 Все теневые', 'profile_all_shadow')],
      [Markup.button.callback('💫 Все парящие', 'profile_all_floating')],
      [Markup.button.callback('➖ Все обычные', 'profile_all_none')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action(/^profile_(back|front|left|right)$/, async ctx => {
  const wall = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText(`📐 *${wall === 'back' ? 'Задняя' : wall === 'front' ? 'Передняя' : wall === 'left' ? 'Левая' : 'Правая'} стена:*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➖ Обычный', `setprofile_${wall}_none`)],
      [Markup.button.callback('🔲 Теневой', `setprofile_${wall}_shadow`)],
      [Markup.button.callback('💫 Парящий', `setprofile_${wall}_floating`)],
      [Markup.button.callback('⬅️ Назад', 'cfg_profiles')]
    ])
  });
});

bot.action(/^setprofile_(.+)_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.profile[ctx.match[1]] = ctx.match[2];
  await ctx.answerCbQuery();

  const p = state.config.profile;
  const icon = (v) => v === 'shadow' ? '🔲' : v === 'floating' ? '💫' : '➖';
  await ctx.editMessageText('📐 *Профили по стенам:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`⬆️ Зад: ${icon(p.back)}`, 'profile_back')],
      [Markup.button.callback(`⬇️ Перед: ${icon(p.front)}`, 'profile_front')],
      [Markup.button.callback(`⬅️ Лево: ${icon(p.left)}`, 'profile_left')],
      [Markup.button.callback(`➡️ Право: ${icon(p.right)}`, 'profile_right')],
      [Markup.button.callback('🔲 Все теневые', 'profile_all_shadow')],
      [Markup.button.callback('💫 Все парящие', 'profile_all_floating')],
      [Markup.button.callback('➖ Все обычные', 'profile_all_none')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action(/^profile_all_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  const value = ctx.match[1];
  state.config.profile = { back: value, front: value, left: value, right: value };
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ УРОВНИ ============

bot.action('cfg_levels', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText('🏗 *Конструкция:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(state.config.twoLevel ? '✅ Двухуровневый' : '⬜ Двухуровневый', 'toggle_twolevel')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action('toggle_twolevel', async ctx => {
  const state = getState(ctx.from.id);
  state.config.twoLevel = !state.config.twoLevel;
  await ctx.answerCbQuery();
  await ctx.editMessageText('🏗 *Конструкция:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(state.config.twoLevel ? '✅ Двухуровневый' : '⬜ Двухуровневый', 'toggle_twolevel')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

// ============ СПОТЫ ============

bot.action('cfg_spots', async ctx => {
  const state = getState(ctx.from.id);
  const s = state.config.spots;
  await ctx.answerCbQuery();

  const buttons = [
    [Markup.button.callback(s.enabled ? '🔴 Выключить' : '🟢 Включить', 'spots_toggle')]
  ];

  if (s.enabled) {
    buttons.push([Markup.button.callback(`Кол-во: ${s.count}`, 'spots_count')]);
    buttons.push([Markup.button.callback(`Форма: ${s.type}`, 'spots_type')]);
    buttons.push([Markup.button.callback(`Цвет: ${s.color}`, 'spots_color')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('💡 *Точечные светильники:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('spots_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.enabled = !state.config.spots.enabled;
  await ctx.answerCbQuery();

  const s = state.config.spots;
  const buttons = [[Markup.button.callback(s.enabled ? '🔴 Выключить' : '🟢 Включить', 'spots_toggle')]];
  if (s.enabled) {
    buttons.push([Markup.button.callback(`Кол-во: ${s.count}`, 'spots_count')]);
    buttons.push([Markup.button.callback(`Форма: ${s.type}`, 'spots_type')]);
    buttons.push([Markup.button.callback(`Цвет: ${s.color}`, 'spots_color')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('💡 *Точечные светильники:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('spots_count', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('💡 *Количество:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('1', 'scount_1'), Markup.button.callback('2', 'scount_2'), Markup.button.callback('4', 'scount_4')],
      [Markup.button.callback('6', 'scount_6'), Markup.button.callback('8', 'scount_8'), Markup.button.callback('10', 'scount_10')],
      [Markup.button.callback('12', 'scount_12'), Markup.button.callback('16', 'scount_16')],
      [Markup.button.callback('⬅️ Назад', 'cfg_spots')]
    ])
  });
});

bot.action(/^scount_(\d+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.count = parseInt(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('spots_type', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('💡 *Форма:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⚪ Круглые', 'stype_round')],
      [Markup.button.callback('⬜ Квадратные', 'stype_square')],
      [Markup.button.callback('⚪⚪ Двойные', 'stype_double')],
      [Markup.button.callback('🔄 Поворотные', 'stype_gimbal')],
      [Markup.button.callback('⬅️ Назад', 'cfg_spots')]
    ])
  });
});

bot.action(/^stype_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.type = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('spots_color', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('💡 *Цвет корпуса:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⬜ Белый', 'scolor_white'), Markup.button.callback('⬛ Чёрный', 'scolor_black')],
      [Markup.button.callback('🟡 Золото', 'scolor_gold'), Markup.button.callback('⚪ Хром', 'scolor_chrome')],
      [Markup.button.callback('⬅️ Назад', 'cfg_spots')]
    ])
  });
});

bot.action(/^scolor_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.color = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ЛЮСТРА ============

bot.action('cfg_chandelier', async ctx => {
  const state = getState(ctx.from.id);
  const c = state.config.chandelier;
  await ctx.answerCbQuery();

  const buttons = [[Markup.button.callback(c.enabled ? '🔴 Выключить' : '🟢 Включить', 'chand_toggle')]];
  if (c.enabled) {
    buttons.push([Markup.button.callback('🔘 Современная', 'chand_modern'), Markup.button.callback('🏛 Классика', 'chand_classic')]);
    buttons.push([Markup.button.callback('💎 Хрусталь', 'chand_crystal'), Markup.button.callback('➖ Минимализм', 'chand_minimalist')]);
    buttons.push([Markup.button.callback('✳️ Спутник', 'chand_sputnik'), Markup.button.callback('⭕ Кольцо', 'chand_ring')]);
    buttons.push([Markup.button.callback('🫧 Кластер', 'chand_cluster'), Markup.button.callback('🏭 Лофт', 'chand_industrial')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('🪔 *Люстра:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('chand_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.chandelier.enabled = !state.config.chandelier.enabled;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action(/^chand_(.+)$/, async ctx => {
  if (ctx.match[1] === 'toggle') return;
  const state = getState(ctx.from.id);
  state.config.chandelier.style = ctx.match[1];
  state.config.chandelier.enabled = true;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ СВЕТОВЫЕ ЛИНИИ ============

bot.action('cfg_lightlines', async ctx => {
  const state = getState(ctx.from.id);
  const l = state.config.lightlines;
  await ctx.answerCbQuery();

  const buttons = [[Markup.button.callback(l.enabled ? '🔴 Выключить' : '🟢 Включить', 'll_toggle')]];
  if (l.enabled) {
    buttons.push([Markup.button.callback(`Кол-во: ${l.count}`, 'll_count')]);
    buttons.push([Markup.button.callback(`Направление: ${l.direction}`, 'll_dir')]);
    buttons.push([Markup.button.callback(`Форма: ${l.shape}`, 'll_shape')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('📏 *Световые линии:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('ll_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightlines.enabled = !state.config.lightlines.enabled;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('ll_count', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📏 *Количество линий:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('1', 'llc_1'), Markup.button.callback('2', 'llc_2'), Markup.button.callback('3', 'llc_3')],
      [Markup.button.callback('4', 'llc_4'), Markup.button.callback('5', 'llc_5')],
      [Markup.button.callback('⬅️ Назад', 'cfg_lightlines')]
    ])
  });
});

bot.action(/^llc_(\d+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightlines.count = parseInt(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('ll_dir', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📏 *Направление:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('↔️ Вдоль', 'lld_along')],
      [Markup.button.callback('↕️ Поперёк', 'lld_across')],
      [Markup.button.callback('↗️ Диагональ', 'lld_diagonal')],
      [Markup.button.callback('⬅️ Назад', 'cfg_lightlines')]
    ])
  });
});

bot.action(/^lld_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightlines.direction = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action('ll_shape', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📏 *Форма линий:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➖ Прямые', 'lls_straight')],
      [Markup.button.callback('⬡ Геометрия', 'lls_geometric')],
      [Markup.button.callback('〰️ Изогнутые', 'lls_curved')],
      [Markup.button.callback('⬅️ Назад', 'cfg_lightlines')]
    ])
  });
});

bot.action(/^lls_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightlines.shape = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ТРЕК ============

bot.action('cfg_track', async ctx => {
  const state = getState(ctx.from.id);
  const t = state.config.track;
  await ctx.answerCbQuery();

  const buttons = [[Markup.button.callback(t.enabled ? '🔴 Выключить' : '🟢 Включить', 'track_toggle')]];
  if (t.enabled) {
    buttons.push([Markup.button.callback('⬛ Чёрный', 'track_black'), Markup.button.callback('⬜ Белый', 'track_white')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('🔦 *Трековая система:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('track_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.track.enabled = !state.config.track.enabled;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action(/^track_(black|white)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.track.color = ctx.match[1];
  state.config.track.enabled = true;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ LED ============

bot.action('cfg_led', async ctx => {
  const state = getState(ctx.from.id);
  const l = state.config.ledStrip;
  await ctx.answerCbQuery();

  const buttons = [[Markup.button.callback(l.enabled ? '🔴 Выключить' : '🟢 Включить', 'led_toggle')]];
  if (l.enabled) {
    buttons.push([Markup.button.callback('🟡 Тёплый', 'led_warm'), Markup.button.callback('⚪ Холодный', 'led_cold')]);
    buttons.push([Markup.button.callback('🌈 RGB', 'led_rgb')]);
  }
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText('💫 *LED подсветка:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('led_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.ledStrip.enabled = !state.config.ledStrip.enabled;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

bot.action(/^led_(warm|cold|rgb)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.ledStrip.color = ctx.match[1];
  state.config.ledStrip.enabled = true;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ НИША ============

bot.action('cfg_niche', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText('🪟 *Ниша для штор:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(state.config.niche ? '✅ Есть' : '⬜ Добавить', 'toggle_niche')],
      [Markup.button.callback('⬅️ Назад', 'back_config')]
    ])
  });
});

bot.action('toggle_niche', async ctx => {
  const state = getState(ctx.from.id);
  state.config.niche = !state.config.niche;
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ НАВИГАЦИЯ ============

bot.action('back_config', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
  } catch (e) {
    await ctx.reply('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
  }
});

// ============ ГЕНЕРАЦИЯ ============

bot.action('generate', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const user = getUser(userId);

  if (!state.photo) {
    return ctx.answerCbQuery('Сначала загрузите фото');
  }

  if (state.processing) {
    return ctx.answerCbQuery('Подождите...');
  }

  // Проверка доступа (кроме админов)
  if (!isAdmin(userId)) {
    if (!user) return ctx.answerCbQuery('Нет доступа');
    if (user.blocked) return ctx.answerCbQuery('Ваш доступ заблокирован');
    if (user.balance < GENERATION_COST) {
      return ctx.answerCbQuery(`Недостаточно средств. Нужно ${GENERATION_COST} ₽`);
    }
  }

  state.processing = true;
  await ctx.answerCbQuery();

  const statusMsg = await ctx.reply('⏳ Обработка...');

  try {
    const prompt = buildPrompt(state.config);
    console.log(`[${userId}] Prompt: ${prompt}`);

    const resizedImage = await sharp(state.photo)
      .resize(1024, 1024, { fit: 'inside' })
      .jpeg({ quality: 90 })
      .toBuffer();

    const base64Image = `data:image/jpeg;base64,${resizedImage.toString('base64')}`;

    const output = await replicate.run("google/nano-banana", {
      input: { prompt, image_input: [base64Image] }
    });

    const resultUrl = Array.isArray(output) ? output[0] : output;
    console.log(`[${userId}] Done: ${resultUrl}`);

    // Списание (кроме админов)
    if (!isAdmin(userId) && user) {
      updateUser(userId, { balance: user.balance - GENERATION_COST });
      addTransaction(userId, -GENERATION_COST, 'generation', 'Генерация визуализации');
    }

    addGeneration(userId, state.config);

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    await ctx.replyWithPhoto({ url: resultUrl }, {
      caption: '✅ *Готово*\n\n' + buildSummary(state.config),
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Изменить', 'back_config')],
        [Markup.button.callback('📸 Новое фото', 'new_visual')],
        [Markup.button.callback('🏠 Меню', 'back_main')]
      ])
    });

  } catch (e) {
    console.error(`[${userId}] Error:`, e.message || e);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply('❌ Ошибка. Попробуйте снова.');
  } finally {
    state.processing = false;
  }
});

// ============ ЗАПУСК ============

bot.launch().then(() => {
  console.log('🚀 Бот запущен');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
