require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sharp = require('sharp');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const Replicate = require('replicate');
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const ADMIN_IDS = process.env.ADMIN_IDS?.split(',').map(id => parseInt(id.trim())) || [];

// PostgreSQL database
const db = require('./db');

const GENERATION_COST = 75; // 75 RUB за генерацию, маржа ~94%

// YooKassa конфигурация
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;
const PAYMENT_WEBHOOK_URL = process.env.PAYMENT_WEBHOOK_URL;

// Express сервер для webhook YooKassa
const app = express();
app.use(express.json());

// Хранилище ожидающих платежей
const pendingPayments = new Map();

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

  // Улучшенный промпт для лучшего качества
  parts.push('Professional interior photo edit. Replace ONLY the ceiling surface. Keep walls, floor, furniture, windows, doors exactly as they are. Maintain original room perspective, lighting direction and shadows.');

  const color = PROMPT_DETAILS.colors[config.color] || PROMPT_DETAILS.colors.white;
  const texture = PROMPT_DETAILS.textures[config.texture] || PROMPT_DETAILS.textures.matte;

  if (config.twoLevel) {
    parts.push(`Install modern two-level stretch ceiling system: main surface is ${color} with ${texture}. Add 15cm dropped gypsum board frame around entire perimeter with integrated cove lighting.`);
  } else {
    parts.push(`Install perfectly flat stretch ceiling: ${color}, ${texture}. Seamless installation from wall to wall.`);
  }

  // Профили - более детальное описание
  const shadowWalls = [];
  const floatingWalls = [];

  for (const [wall, type] of Object.entries(config.profile)) {
    if (type === 'shadow') shadowWalls.push(wall);
    else if (type === 'floating') floatingWalls.push(wall);
  }

  if (shadowWalls.length > 0) {
    parts.push(`Add shadow gap profile (8-10mm black recessed line creating visual separation) where ceiling meets ${shadowWalls.length === 4 ? 'all four walls' : shadowWalls.length + ' wall(s)'}. Creates floating illusion.`);
  }
  if (floatingWalls.length > 0) {
    parts.push(`Add floating ceiling effect with hidden LED perimeter lighting (soft warm white glow emanating from 3cm gap between ceiling and ${floatingWalls.length === 4 ? 'all walls' : floatingWalls.length + ' wall(s)'}).`);
  }

  // Споты - улучшенное описание с точным позиционированием
  if (config.spots.enabled && config.spots.count > 0) {
    const spotType = PROMPT_DETAILS.spots.types[config.spots.type] || PROMPT_DETAILS.spots.types.round;
    const spotColor = PROMPT_DETAILS.spots.colors[config.spots.color] || 'white housing';

    // Описание сетки
    let gridDesc;
    switch (config.spots.count) {
      case 1: gridDesc = 'single centered recessed downlight'; break;
      case 2: gridDesc = 'two recessed downlights in a row, evenly spaced'; break;
      case 4: gridDesc = 'four recessed downlights in 2x2 symmetrical grid pattern'; break;
      case 6: gridDesc = 'six recessed downlights in 2 rows of 3, symmetrically arranged'; break;
      case 8: gridDesc = 'eight recessed downlights in 2 rows of 4, evenly distributed'; break;
      case 10: gridDesc = 'ten recessed downlights in 2 rows of 5'; break;
      case 12: gridDesc = 'twelve recessed downlights in 3 rows of 4, grid pattern'; break;
      case 16: gridDesc = 'sixteen recessed downlights in 4x4 grid'; break;
      default: gridDesc = `${config.spots.count} recessed downlights evenly distributed across ceiling`; break;
    }

    parts.push(`Install ${gridDesc}. Each light is ${spotType} with ${spotColor}, 5-7cm diameter, all lights turned ON emitting warm white light.`);
  }

  if (config.chandelier.enabled) {
    const style = PROMPT_DETAILS.chandeliers[config.chandelier.style] || PROMPT_DETAILS.chandeliers.modern;
    parts.push(`Hang one elegant ${style} from exact ceiling center, appropriately sized for the room, turned ON.`);
  }

  if (config.lightlines.enabled && config.lightlines.count > 0) {
    const direction = PROMPT_DETAILS.lightlines.directions[config.lightlines.direction];
    const shape = PROMPT_DETAILS.lightlines.shapes[config.lightlines.shape];
    parts.push(`Install ${config.lightlines.count} ${shape} ${direction} the room, recessed into ceiling with even spacing, emitting bright white linear light.`);
  }

  if (config.track.enabled) {
    const trackDesc = config.track.color === 'black'
      ? 'sleek black magnetic track lighting system with 4-6 adjustable spotlights'
      : 'modern white magnetic track lighting system with 4-6 adjustable spotlights';
    parts.push(`Mount ${trackDesc} running along ceiling center.`);
  }

  if (config.ledStrip.enabled) {
    const ledColor = config.ledStrip.color === 'warm' ? 'warm white (3000K)' : config.ledStrip.color === 'cold' ? 'cool white (6000K)' : 'RGB multicolor';
    parts.push(`Add continuous ${ledColor} LED strip lighting hidden in ceiling perimeter, creating ambient glow around entire room.`);
  }

  if (config.niche) {
    parts.push('Include recessed ceiling niche (15cm deep slot) at window wall for hidden curtain track/rod.');
  }

  parts.push('Ultra photorealistic result. Professional architectural photography quality. Sharp details, accurate materials, proper light reflections matching original room lighting.');

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

// Постоянная клавиатура внизу экрана
function persistentKeyboard(isAdminUser) {
  if (isAdminUser) {
    return Markup.keyboard([
      ['📸 Новая визуализация', '🖼 Мои работы'],
      ['💳 Пополнение', '👑 Админ-панель'],
      ['📖 Помощь']
    ]).resize();
  }
  return Markup.keyboard([
    ['📸 Новая визуализация', '🖼 Мои работы'],
    ['💰 Баланс', '💳 Пополнить'],
    ['📖 Помощь']
  ]).resize();
}

async function mainMenuKeyboard(userId) {
  const user = await db.getUser(userId);
  const buttons = [];

  if (isAdmin(userId)) {
    buttons.push([Markup.button.callback('📸 Новая визуализация', 'new_visual')]);
    buttons.push([Markup.button.callback('🖼 Мои работы', 'my_works')]);
    buttons.push([Markup.button.callback('💳 Оплата / Пополнение', 'pay_balance')]);
    buttons.push([Markup.button.callback('👑 Админ-панель', 'admin')]);
  } else if (user) {
    buttons.push([Markup.button.callback('📸 Новая визуализация', 'new_visual')]);
    buttons.push([Markup.button.callback('🖼 Мои работы', 'my_works')]);
    buttons.push([Markup.button.callback('💰 Баланс: ' + (user.balance || 0) + ' ₽', 'balance')]);
    buttons.push([Markup.button.callback('💳 Пополнить баланс', 'pay_balance')]);
  }

  return Markup.inlineKeyboard(buttons);
}

// ============ КОМАНДА START ============

bot.command('start', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  let text = '🏠 *Визуализация натяжных потолков*\n\n';

  const disclaimer = '💡 _Умная нейросеть создаёт визуализации за секунды — покажите клиенту будущий потолок прямо на встрече!\n\n⚠️ Любой ИИ может немного отклоняться от настроек: добавить 4 светильника вместо 2 или изменить оттенок — так устроены все нейросети в мире. Мы используем лучшие технологии и максимально точные промпты._';

  if (isAdmin(userId)) {
    text += '👑 Вы администратор\n\n';
    text += disclaimer;
  } else if (user) {
    const company = await db.getCompany(user.company_id);
    text += `🏢 ${company?.name || 'Компания'}\n`;
    text += `💰 Баланс: ${user.balance} ₽\n\n`;
    text += disclaimer;
  } else {
    // Проверяем, есть ли уже заявка
    const existingRequest = await db.getAccessRequestByUserId(userId);

    if (existingRequest) {
      text += '⏳ Ваша заявка на рассмотрении.\n\n';
      text += 'Ожидайте подтверждения администратора.';
      await ctx.reply(text, { parse_mode: 'Markdown' });
    } else {
      // Описание преимуществ для новых пользователей
      const welcomeText = `🏠 *Визуализация натяжных потолков*

🎯 *Что вы получите:*

📸 *Мгновенная визуализация* — загрузите фото комнаты и получите реалистичный результат за 30-60 секунд

🎨 *Гибкие настройки:*
  • 8 цветов потолка (белый, бежевый, чёрный и др.)
  • 4 текстуры (матовый, глянцевый, сатин, металлик)
  • Теневые и парящие профили
  • Одно- и двухуровневые конструкции

💡 *Освещение на любой вкус:*
  • Точечные светильники (1-16 шт)
  • Люстры разных стилей
  • Световые линии
  • Трековые системы
  • LED-подсветка

⭐ *Дополнительные возможности:*
  • Быстрые пресеты (Минимализм, Классика, Премиум)
  • Сохранение любимых конфигураций
  • История всех генераций
  • Перегенерация с теми же настройками

💼 *Идеально для:*
  • Показа клиенту прямо на замере
  • Презентации вариантов в офисе
  • Согласования дизайна до монтажа

_Стоимость: 75₽ за генерацию_`;

      await ctx.reply(welcomeText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('📝 Запросить доступ', 'request_access')]])
      });
    }
    return;
  }

  // Отправляем с постоянной клавиатурой
  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...persistentKeyboard(isAdmin(userId))
  });
});

// ============ ОБРАБОТКА КНОПОК КЛАВИАТУРЫ ============

bot.hears('📸 Новая визуализация', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!isAdmin(userId) && !user) {
    return ctx.reply('⚠️ У вас нет доступа. Отправьте /start для регистрации.');
  }

  if (!isAdmin(userId) && user.balance < GENERATION_COST) {
    return ctx.reply(
      `❌ Недостаточно средств.\n\nНужно: ${GENERATION_COST} ₽\nВаш баланс: ${user.balance} ₽`,
      Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить', 'pay_balance')]])
    );
  }

  const state = getState(userId);
  state.photo = null;
  state.config = getDefaultConfig();
  state.step = 'waiting_photo';

  await ctx.reply(
    '📸 *Новая визуализация*\n\n' +
    'Отправьте фото комнаты для визуализации потолка.\n\n' +
    '_Лучше всего подходят фото с видом на потолок целиком._',
    { parse_mode: 'Markdown' }
  );
});

bot.hears('🖼 Мои работы', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.reply('⚠️ У вас нет доступа.');
  }

  const allGenerations = await db.getUserGenerations(userId);
  const generations = allGenerations.slice(0, 10);

  if (generations.length === 0) {
    return ctx.reply(
      '🖼 *Мои работы*\n\nУ вас пока нет генераций.\n\nНажмите "📸 Новая визуализация" чтобы создать первую!',
      { parse_mode: 'Markdown' }
    );
  }

  const buttons = generations.map((gen, index) => {
    const date = new Date(gen.created_at).toLocaleDateString('ru-RU');
    const colors = { white: '⬜', ivory: '🤍', beige: '🟨', gray: '⬛', darkgray: '🖤', black: '⚫', blue: '🔵', pink: '🩷' };
    const config = typeof gen.config === 'string' ? JSON.parse(gen.config) : gen.config;
    const colorIcon = colors[config?.color] || '⬜';
    return [Markup.button.callback(`${colorIcon} ${date} #${generations.length - index}`, `view_work_${gen.id}`)];
  });

  await ctx.reply(
    `🖼 *Мои работы*\n\nПоследние ${generations.length} генераций:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.hears('💰 Баланс', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user) {
    return ctx.reply('⚠️ У вас нет доступа. Отправьте /start для регистрации.');
  }

  const gensAvailable = Math.floor(user.balance / GENERATION_COST);
  await ctx.reply(
    `💰 *Ваш баланс: ${user.balance} ₽*\n\n` +
    `📊 Стоимость генерации: ${GENERATION_COST} ₽\n` +
    `🖼 Доступно генераций: ${gensAvailable}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Пополнить', 'pay_balance')],
        [Markup.button.callback('📜 История', 'history')]
      ])
    }
  );
});

bot.hears(['💳 Пополнить', '💳 Пополнение'], async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.reply('⚠️ У вас нет доступа. Отправьте /start для регистрации.');
  }

  await ctx.reply(
    '💳 *Пополнение баланса*\n\n' +
    'Выберите сумму пополнения:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('300 ₽ (4 генерации)', 'pay_300')],
        [Markup.button.callback('500 ₽ (6 генераций)', 'pay_500')],
        [Markup.button.callback('1000 ₽ (13 генераций)', 'pay_1000')],
        [Markup.button.callback('2000 ₽ (26 генераций)', 'pay_2000')]
      ])
    }
  );
});

bot.hears('👑 Админ-панель', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const stats = await db.getStats();

  await ctx.reply(
    '👑 *Админ-панель*\n\n' +
    `🏢 Компаний: ${stats.companies_count}\n` +
    `👥 Пользователей: ${stats.users_count}` + (parseInt(stats.blocked_count) > 0 ? ` (🚫 ${stats.blocked_count})` : '') + '\n' +
    `💰 Баланс на счетах: ${stats.total_balance} ₽\n` +
    `🖼 Всего генераций: ${stats.generations_count}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏢 Компании', 'admin_companies'), Markup.button.callback('👥 Все пользователи', 'admin_all_users')],
        [Markup.button.callback(`📋 Заявки (${stats.requests_count})`, 'admin_requests')],
        [Markup.button.callback('⚠️ Низкий баланс', 'admin_low_balance')],
        [Markup.button.callback('📊 Статистика', 'admin_stats'), Markup.button.callback('💳 Транзакции', 'admin_transactions')]
      ])
    }
  );
});

bot.hears('📖 Помощь', async ctx => {
  const helpText = `📖 *Помощь*

*Как пользоваться ботом:*

1️⃣ Нажмите "📸 Новая визуализация"
2️⃣ Загрузите фото комнаты
3️⃣ Настройте параметры потолка
4️⃣ Нажмите "Сгенерировать"
5️⃣ Получите результат за 30-60 сек

*Доступные настройки:*
🎨 Цвет и текстура потолка
📐 Профили (теневой, парящий)
🏗 Уровни (одно-/двухуровневый)
💡 Освещение (споты, люстры, линии)
💫 LED-подсветка и ниши

*Стоимость:* 75₽ за генерацию`;

  await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// ============ ДОПОЛНИТЕЛЬНЫЕ КОМАНДЫ ============

bot.command('help', async ctx => {
  const helpText = `📖 *Помощь*

*Как пользоваться ботом:*

1️⃣ Нажмите "Новая визуализация"
2️⃣ Загрузите фото комнаты
3️⃣ Настройте параметры потолка
4️⃣ Нажмите "Сгенерировать"
5️⃣ Получите результат за 30-60 сек

*Доступные настройки:*
🎨 Цвет и текстура потолка
📐 Профили (теневой, парящий)
🏗 Уровни (одно-/двухуровневый)
💡 Освещение (споты, люстры, линии)
💫 LED-подсветка и ниши

*Команды:*
/start — главное меню
/new — новая визуализация
/balance — проверить баланс
/help — эта справка

*Стоимость:* 75₽ за генерацию`;

  await ctx.reply(helpText, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'back_main')]])
  });
});

bot.command('balance', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.reply('⚠️ У вас нет доступа. Отправьте /start для регистрации.');
  }

  if (isAdmin(userId)) {
    return ctx.reply('👑 Вы администратор — баланс не ограничен!', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Меню', 'back_main')]])
    });
  }

  const gensAvailable = Math.floor(user.balance / GENERATION_COST);
  await ctx.reply(
    `💰 *Ваш баланс: ${user.balance} ₽*\n\n` +
    `📊 Стоимость генерации: ${GENERATION_COST} ₽\n` +
    `🖼 Доступно генераций: ${gensAvailable}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Пополнить', 'pay_balance')],
        [Markup.button.callback('🏠 Меню', 'back_main')]
      ])
    }
  );
});

bot.command('new', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!isAdmin(userId) && !user) {
    return ctx.reply('⚠️ У вас нет доступа. Отправьте /start для регистрации.');
  }

  if (!isAdmin(userId) && user.balance < GENERATION_COST) {
    return ctx.reply(
      `❌ Недостаточно средств.\n\nНужно: ${GENERATION_COST} ₽\nВаш баланс: ${user.balance} ₽`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить', 'pay_balance')]])
      }
    );
  }

  const state = getState(userId);
  state.photo = null;
  state.config = getDefaultConfig();
  state.step = 'waiting_photo';

  await ctx.reply(
    '📸 *Новая визуализация*\n\n' +
    'Отправьте фото комнаты для визуализации потолка.\n\n' +
    '_Лучше всего подходят фото с видом на потолок целиком._',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'back_main')]])
    }
  );
});

// ============ ЗАПРОС ДОСТУПА ============

bot.action('request_access', async ctx => {
  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || '';
  const lastName = ctx.from.last_name || '';

  const request = await db.addAccessRequest(userId, username, firstName, lastName);

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
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Нет доступа');

  await ctx.answerCbQuery();

  await ctx.editMessageText(
    `💰 *Ваш баланс: ${user.balance} ₽*\n\n` +
    `📊 Стоимость генерации: ${GENERATION_COST} ₽\n` +
    `🖼 Доступно генераций: ${Math.floor(user.balance / GENERATION_COST)}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Пополнить баланс', 'pay_balance')],
        [Markup.button.callback('📜 История', 'history')],
        [Markup.button.callback('⬅️ Назад', 'back_main')]
      ])
    }
  );
});

bot.action('history', async ctx => {
  const userId = ctx.from.id;
  const transactions = await db.getUserTransactions(userId);
  const lastTen = transactions.slice(0, 10);

  let text = '📜 *История операций*\n\n';
  if (lastTen.length === 0) {
    text += 'Пока нет операций';
  } else {
    lastTen.forEach(t => {
      const sign = t.amount >= 0 ? '+' : '';
      const date = new Date(t.created_at).toLocaleDateString('ru-RU');
      text += `${sign}${t.amount} ₽ — ${t.description} (${date})\n`;
    });
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'balance')]])
  });
});

// ============ МОИ РАБОТЫ ============

bot.action('my_works', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.answerCbQuery('Нет доступа');
  }

  const allGenerations = await db.getUserGenerations(userId);
  const generations = allGenerations.slice(0, 10);

  if (generations.length === 0) {
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '🖼 *Мои работы*\n\nУ вас пока нет генераций.\n\nНажмите "Новая визуализация" чтобы создать первую!',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📸 Новая визуализация', 'new_visual')],
          [Markup.button.callback('⬅️ Назад', 'back_main')]
        ])
      }
    );
  }

  // Показываем список генераций
  const buttons = generations.map((gen, index) => {
    const date = new Date(gen.created_at).toLocaleDateString('ru-RU');
    const colors = { white: '⬜', ivory: '🤍', beige: '🟨', gray: '⬛', darkgray: '🖤', black: '⚫', blue: '🔵', pink: '🩷' };
    const config = typeof gen.config === 'string' ? JSON.parse(gen.config) : gen.config;
    const colorIcon = colors[config?.color] || '⬜';
    return [Markup.button.callback(`${colorIcon} ${date} #${generations.length - index}`, `view_work_${gen.id}`)];
  });

  buttons.push([Markup.button.callback('⬅️ Назад', 'back_main')]);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🖼 *Мои работы*\n\nПоследние ${generations.length} генераций:\n\n` +
    '_Нажмите на работу чтобы посмотреть_\n' +
    '_⚠️ Изображения доступны ~24 часа_',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^view_work_(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const genId = parseInt(ctx.match[1]);

  const generations = await db.getUserGenerations(userId);
  const gen = generations.find(g => g.id === genId);

  if (!gen) {
    return ctx.answerCbQuery('Работа не найдена');
  }

  await ctx.answerCbQuery();

  const date = new Date(gen.created_at).toLocaleString('ru-RU');
  const config = typeof gen.config === 'string' ? JSON.parse(gen.config) : gen.config;

  if (gen.result_url) {
    try {
      await ctx.replyWithPhoto({ url: gen.result_url }, {
        caption: `🖼 *Генерация от ${date}*\n\n` + buildSummary(config),
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 К списку работ', 'my_works')],
          [Markup.button.callback('🏠 Меню', 'back_main')]
        ])
      });
    } catch (e) {
      // URL истёк
      await ctx.reply(
        `🖼 *Генерация от ${date}*\n\n` +
        buildSummary(config) +
        '\n\n⚠️ _Изображение больше недоступно (истёк срок хранения)_',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔙 К списку работ', 'my_works')],
            [Markup.button.callback('🏠 Меню', 'back_main')]
          ])
        }
      );
    }
  } else {
    await ctx.reply(
      `🖼 *Генерация от ${date}*\n\n` +
      buildSummary(config) +
      '\n\n⚠️ _Изображение не сохранено_',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 К списку работ', 'my_works')],
          [Markup.button.callback('🏠 Меню', 'back_main')]
        ])
      }
    );
  }
});

// ============ АДМИН-ПАНЕЛЬ ============

bot.action('admin', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет доступа');

  const stats = await db.getStats();

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '👑 *Админ-панель*\n\n' +
    `🏢 Компаний: ${stats.companies_count}\n` +
    `👥 Пользователей: ${stats.users_count}` + (parseInt(stats.blocked_count) > 0 ? ` (🚫 ${stats.blocked_count})` : '') + '\n' +
    `💰 Баланс на счетах: ${stats.total_balance} ₽\n` +
    `🖼 Всего генераций: ${stats.generations_count}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏢 Компании', 'admin_companies'), Markup.button.callback('👥 Все пользователи', 'admin_all_users')],
        [Markup.button.callback(`📋 Заявки (${stats.requests_count})`, 'admin_requests')],
        [Markup.button.callback('⚠️ Низкий баланс', 'admin_low_balance')],
        [Markup.button.callback('📊 Статистика', 'admin_stats'), Markup.button.callback('💳 Транзакции', 'admin_transactions')],
        [Markup.button.callback('⬅️ Назад', 'back_main')]
      ])
    }
  );
});

// ============ НИЗКИЙ БАЛАНС ============

bot.action('admin_low_balance', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const lowBalanceUsers = await db.getLowBalanceUsers(150); // 2 генерации = 150₽

  await ctx.answerCbQuery();

  if (lowBalanceUsers.length === 0) {
    await ctx.editMessageText(
      '⚠️ *Пользователи с низким балансом*\n\n' +
      '✅ Нет пользователей с балансом ≤150₽',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
      }
    );
    return;
  }

  let text = `⚠️ *Пользователи с низким балансом*\n\n`;
  text += `Пользователей: ${lowBalanceUsers.length}\n\n`;

  lowBalanceUsers.slice(0, 15).forEach((u, i) => {
    const gensLeft = Math.floor(u.balance / GENERATION_COST);
    text += `${i + 1}. ${u.name || 'Без имени'} (${u.company_name || '—'})\n`;
    text += `   💰 ${u.balance}₽ = ${gensLeft} генераций\n`;
  });

  if (lowBalanceUsers.length > 15) {
    text += `\n...и ещё ${lowBalanceUsers.length - 15} пользователей`;
  }

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📨 Уведомить всех', 'notify_low_balance')],
      [Markup.button.callback('⬅️ Назад', 'admin')]
    ])
  });
});

bot.action('notify_low_balance', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const lowBalanceUsers = await db.getLowBalanceUsers(150);
  let sent = 0;

  for (const user of lowBalanceUsers) {
    try {
      const gensLeft = Math.floor(user.balance / GENERATION_COST);
      await bot.telegram.sendMessage(user.id,
        `⚠️ *Низкий баланс*\n\n` +
        `Ваш баланс: ${user.balance}₽\n` +
        `Осталось генераций: ${gensLeft}\n\n` +
        `Пополните баланс, чтобы продолжить создавать визуализации!`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить', 'pay_balance')]])
        }
      );
      sent++;
    } catch (e) {
      // Пользователь заблокировал бота
    }
  }

  await ctx.answerCbQuery(`Уведомлено ${sent} из ${lowBalanceUsers.length} пользователей`);
});

// ============ ВСЕ ПОЛЬЗОВАТЕЛИ ============

bot.action('admin_all_users', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const users = Object.values(await db.getAllUsers());
  const companies = await db.getCompanies();

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
    const company = companies[u.company_id];
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
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const company = await db.getCompany(user.company_id);
  const gens = await db.getUserGenerations(userId);
  const txs = await db.getUserTransactions(userId);
  const totalSpent = txs.filter(t => t.type === 'generation').reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const regDate = new Date(user.created_at).toLocaleDateString('ru-RU');

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
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const newStatus = !user.blocked;
  await db.updateUser(userId, { blocked: newStatus });

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
  const company = await db.getCompany(user.company_id);
  const gens = await db.getUserGenerations(userId);
  const txs = await db.getUserTransactions(userId);
  const totalSpent = txs.filter(t => t.type === 'generation').reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const regDate = new Date(user.created_at).toLocaleDateString('ru-RU');

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
  const user = await db.getUser(userId);
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

  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const deductAmount = Math.min(amount, user.balance);
  if (deductAmount <= 0) return ctx.answerCbQuery('Нечего списывать');

  await db.updateUser(userId, { balance: user.balance - deductAmount });
  await db.addTransaction(userId, -deductAmount, 'deduct', 'Списание администратором');

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
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const companies = Object.values(await db.getCompanies());

  if (companies.length === 0) {
    return ctx.answerCbQuery('Нет компаний');
  }

  const buttons = companies.map(c => [
    Markup.button.callback(
      (c.id === user.company_id ? '✅ ' : '') + c.name,
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

  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  await db.updateUser(userId, { companyId });

  await ctx.answerCbQuery(`Перемещён в ${company.name}`);
  await ctx.editMessageText(`✅ Пользователь перемещён в "${company.name}"`, {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К пользователю', `admin_user_${userId}`)]])
  });
});

// История операций пользователя
bot.action(/^user_history_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const txs = await db.getUserTransactions(userId).slice(-15).reverse();

  let text = `📜 *История операций*\n\n`;

  if (txs.length === 0) {
    text += 'Нет операций';
  } else {
    txs.forEach(t => {
      const sign = t.amount >= 0 ? '+' : '';
      const date = new Date(t.created_at).toLocaleDateString('ru-RU');
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
  const user = await db.getUser(userId);
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
  await db.deleteUser(userId);

  await ctx.answerCbQuery('Удалён');
  await ctx.editMessageText('✅ Пользователь удалён', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К пользователям', 'admin_all_users')]])
  });
});

// ============ ТРАНЗАКЦИИ ============

bot.action('admin_transactions', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const txs = await db.getAllTransactions().slice(-20).reverse();
  const users = await db.getAllUsers();

  let text = `💳 *Последние транзакции*\n\n`;

  if (txs.length === 0) {
    text += 'Нет транзакций';
  } else {
    txs.forEach(t => {
      const user = users[t.user_id];
      const userName = user?.name || 'ID:' + t.user_id;
      const sign = t.amount >= 0 ? '+' : '';
      const date = new Date(t.created_at).toLocaleDateString('ru-RU');
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

  const requests = await db.getAccessRequests();

  if (requests.length === 0) {
    await ctx.answerCbQuery();
    await ctx.editMessageText('📋 *Заявки на доступ*\n\nНет новых заявок', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
    return;
  }

  const buttons = requests.slice(0, 10).map(r => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Без имени';
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
  const requests = await db.getAccessRequests();
  const request = requests.find(r => r.id === requestId);

  if (!request) {
    return ctx.answerCbQuery('Заявка не найдена');
  }

  const name = [request.first_name, request.last_name].filter(Boolean).join(' ') || 'Без имени';
  const userLink = request.username ? `@${request.username}` : `ID: ${request.user_id}`;
  const date = new Date(request.created_at).toLocaleDateString('ru-RU');

  // Получаем список компаний для выбора
  const companies = Object.values(await db.getCompanies());

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
    `🆔 \`${request.user_id}\`\n` +
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

  const requests = await db.getAccessRequests();
  const request = requests.find(r => r.id === requestId);

  if (!request) {
    return ctx.answerCbQuery('Заявка не найдена');
  }

  const company = await db.getCompany(companyId);
  if (!company) {
    return ctx.answerCbQuery('Компания не найдена');
  }

  const name = [request.first_name, request.last_name].filter(Boolean).join(' ') || 'Пользователь';

  // Создаём пользователя
  await db.createUser(request.user_id, companyId, name);

  // Удаляем заявку
  await db.deleteAccessRequest(requestId);

  // Уведомляем пользователя
  try {
    await bot.telegram.sendMessage(request.user_id,
      `🎉 Ваша заявка одобрена!\n\n` +
      `🏢 Компания: ${company.name}\n\n` +
      `Отправьте /start чтобы начать.`
    );
  } catch (e) {}

  await ctx.answerCbQuery('Одобрено');

  // Возвращаемся к списку заявок
  const remainingRequests = await db.getAccessRequests();
  if (remainingRequests.length === 0) {
    await ctx.editMessageText('📋 *Заявки на доступ*\n\n✅ Все заявки обработаны', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
  } else {
    const buttons = remainingRequests.slice(0, 10).map(r => {
      const n = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Без имени';
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
  const requests = await db.getAccessRequests();
  const request = requests.find(r => r.id === requestId);

  if (!request) {
    return ctx.answerCbQuery('Заявка не найдена');
  }

  // Удаляем заявку
  await db.deleteAccessRequest(requestId);

  // Уведомляем пользователя
  try {
    await bot.telegram.sendMessage(request.user_id, '❌ Ваша заявка на доступ отклонена.');
  } catch (e) {}

  await ctx.answerCbQuery('Отклонено');

  // Возвращаемся к списку заявок
  const remainingRequests = await db.getAccessRequests();
  if (remainingRequests.length === 0) {
    await ctx.editMessageText('📋 *Заявки на доступ*\n\nНет новых заявок', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin')]])
    });
  } else {
    const buttons = remainingRequests.slice(0, 10).map(r => {
      const n = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Без имени';
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

  const companies = Object.values(await db.getCompanies());

  const buttons = [];
  for (const c of companies.slice(0, 10)) {
    const users = await db.getCompanyUsers(c.id);
    const totalBalance = users.reduce((sum, u) => sum + (u.balance || 0), 0);
    buttons.push([Markup.button.callback(`🏢 ${c.name} (${users.length} чел, ${totalBalance}₽)`, `company_${c.id}`)]);
  }

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
  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = await db.getCompanyUsers(companyId);
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
  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = await db.getCompanyUsers(companyId);
  const allGens = await db.getAllGenerations();
  const allTxs = await db.getAllTransactions();

  // Статистика по компании
  let totalGens = 0;
  let totalSpent = 0;
  let totalTopups = 0;
  let totalBalance = 0;

  const userStats = users.map(u => {
    const userGens = allGens.filter(g => g.user_id == u.id);
    const userTxs = allTxs.filter(t => t.user_id == u.id);
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
  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = await db.getCompanyUsers(companyId);

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

  const company = await db.getCompany(companyId);
  if (!company) return ctx.answerCbQuery('Компания не найдена');

  const users = await db.getCompanyUsers(companyId);
  const allGens = await db.getAllGenerations();
  const allTxs = await db.getAllTransactions();

  // Формируем отчёт
  let totalGens = 0;
  let totalSpent = 0;
  let totalBalance = 0;

  const userStats = users.map(u => {
    const userGens = allGens.filter(g => g.user_id == u.id);
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
  const company = await db.getCompany(companyId);
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
  const users = await db.getCompanyUsers(companyId);

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
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const allGens = await db.getAllGenerations();
  const gens = allGens.filter(g => g.user_id == userId).length;

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
        [Markup.button.callback('⬅️ Назад', `manage_users_${user.company_id}`)]
      ])
    }
  );
});

bot.action(/^delete_user_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  const companyId = user.company_id;
  await db.deleteUser(userId);

  await ctx.answerCbQuery('Удалён');

  // Возврат к списку сотрудников
  const users = await db.getCompanyUsers(companyId);
  if (users.length === 0) {
    // Если сотрудников не осталось, возвращаемся к компании
    const company = await db.getCompany(companyId);
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
  const users = await db.getCompanyUsers(companyId);

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
  const user = await db.getUser(userId);
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

  const user = await db.getUser(userId);
  if (!user) return ctx.answerCbQuery('Пользователь не найден');

  await db.updateUser(userId, { balance: (user.balance || 0) + amount });
  await db.addTransaction(userId, amount, 'topup', 'Пополнение администратором');

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
  const company = await db.getCompany(companyId);
  const users = await db.getCompanyUsers(companyId);

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
  const users = await db.getCompanyUsers(companyId);

  // Удаляем всех сотрудников
  for (const u of users) {
    await db.deleteUser(u.id);
  }
  // Удаляем компанию
  await db.deleteCompany(companyId);

  await ctx.answerCbQuery('Компания удалена');

  // Возврат к списку компаний
  const companies = Object.values(await db.getCompanies());
  const buttons = [];
  for (const c of companies.slice(0, 10)) {
    const cUsers = await db.getCompanyUsers(c.id);
    const totalBalance = cUsers.reduce((sum, u) => sum + (u.balance || 0), 0);
    buttons.push([Markup.button.callback(`🏢 ${c.name} (${cUsers.length} чел, ${totalBalance}₽)`, `company_${c.id}`)]);
  }
  buttons.push([Markup.button.callback('➕ Добавить компанию', 'add_company')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin')]);

  await ctx.editMessageText('🏢 *Компании*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// ============ СТАТИСТИКА ============

bot.action('admin_stats', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const stats = await db.getStats();
  const allTransactions = await db.getAllTransactions();
  const totalRevenue = allTransactions
    .filter(t => t.type === 'topup')
    .reduce((sum, t) => sum + t.amount, 0);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '📊 *Статистика*\n\n' +
    '*Сегодня:*\n' +
    `🖼 Генераций: ${stats.today_generations}\n` +
    `💰 Пополнений: ${stats.today_topups} ₽\n\n` +
    '*Всего:*\n' +
    `🖼 Генераций: ${stats.generations_count}\n` +
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
  const user = await db.getUser(userId);

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

  const user = await db.getUser(userId);
  let text = '🏠 *Визуализация натяжных потолков*\n\n';

  const disclaimer = '💡 _Умная нейросеть создаёт визуализации за секунды — покажите клиенту будущий потолок прямо на встрече!\n\n⚠️ Любой ИИ может немного отклоняться от настроек: добавить 4 светильника вместо 2 или изменить оттенок — так устроены все нейросети в мире. Мы используем лучшие технологии и максимально точные промпты._';

  if (isAdmin(userId)) {
    text += '👑 Вы администратор\n\n';
    text += disclaimer;
  } else if (user) {
    const company = await db.getCompany(user.company_id);
    text += `🏢 ${company?.name || 'Компания'}\n`;
    text += `💰 Баланс: ${user.balance} ₽\n\n`;
    text += disclaimer;
  }

  // Отправляем новое сообщение с постоянной клавиатурой
  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...persistentKeyboard(isAdmin(userId))
  });
});

// ============ ЗАГРУЗКА ФОТО ============

bot.on('photo', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!isAdmin(userId) && !user) {
    return ctx.reply('⚠️ У вас нет доступа. Обратитесь к администратору.');
  }

  if (!isAdmin(userId) && user.balance < GENERATION_COST) {
    return ctx.reply(
      `❌ Недостаточно средств. Нужно ${GENERATION_COST} ₽`,
      Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить', 'pay_balance')]])
    );
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
    await ctx.reply('❌ Ошибка загрузки фото');
  }
});

// ============ ОБРАБОТКА ТЕКСТА ============

bot.on('text', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const text = ctx.message.text;

  // Добавление компании
  if (state.step === 'add_company_name' && isAdmin(userId)) {
    const company = await db.addCompany(text);
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

    await db.updateCompany(companyId, { name: newName });
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

    if (await db.getUser(newUserId)) {
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

    await db.createUser(newUserId, companyId, name);

    state.step = null;
    state.tempData = {};

    try {
      const company = await db.getCompany(companyId);
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

  // Сохранение избранной конфигурации
  if (state.step === 'save_favorite_name') {
    const name = text.trim().slice(0, 50); // ограничим 50 символами

    await db.addFavorite(userId, name, state.config);
    state.step = null;

    return ctx.reply(
      `✅ Конфигурация "${name}" сохранена в избранное!`,
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⭐ Избранное', 'favorites')],
          [Markup.button.callback('⬅️ К настройкам', 'back_config')]
        ])
      }
    );
  }
});

// Обработка пересланных сообщений для получения ID
bot.on('forward', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);

  if (state.step === 'add_user_id' && isAdmin(userId) && ctx.message.forward_from) {
    const forwardedUserId = ctx.message.forward_from.id.toString();

    if (await db.getUser(forwardedUserId)) {
      return ctx.reply('❌ Этот пользователь уже добавлен.');
    }

    state.tempData.newUserId = forwardedUserId;
    state.step = 'add_user_name';

    const forwardedName = ctx.message.forward_from.first_name || '';
    return ctx.reply(`👤 ID: ${forwardedUserId}\n\nВведите имя сотрудника (или оставьте "${forwardedName}"):`);
  }
});

// ============ ПРЕСЕТЫ ============

const PRESETS = {
  minimalism: {
    name: '🔲 Минимализм',
    description: 'Чистые линии, никаких излишеств',
    config: {
      color: 'white',
      texture: 'matte',
      profile: { back: 'shadow', front: 'shadow', left: 'shadow', right: 'shadow' },
      spots: { enabled: true, count: 4, type: 'round', color: 'white' },
      chandelier: { enabled: false, style: 'modern' },
      lightlines: { enabled: false, count: 1, direction: 'along', shape: 'straight' },
      track: { enabled: false, color: 'black' },
      ledStrip: { enabled: false, color: 'warm' },
      niche: false,
      twoLevel: false
    }
  },
  classic: {
    name: '🏛 Классика',
    description: 'Элегантно с люстрой',
    config: {
      color: 'ivory',
      texture: 'satin',
      profile: { back: 'none', front: 'none', left: 'none', right: 'none' },
      spots: { enabled: false, count: 6, type: 'round', color: 'gold' },
      chandelier: { enabled: true, style: 'classic' },
      lightlines: { enabled: false, count: 1, direction: 'along', shape: 'straight' },
      track: { enabled: false, color: 'white' },
      ledStrip: { enabled: true, color: 'warm' },
      niche: true,
      twoLevel: false
    }
  },
  premium: {
    name: '💎 Премиум',
    description: 'Двухуровневый с подсветкой',
    config: {
      color: 'white',
      texture: 'glossy',
      profile: { back: 'floating', front: 'floating', left: 'floating', right: 'floating' },
      spots: { enabled: true, count: 8, type: 'round', color: 'white' },
      chandelier: { enabled: true, style: 'ring' },
      lightlines: { enabled: false, count: 2, direction: 'along', shape: 'straight' },
      track: { enabled: false, color: 'black' },
      ledStrip: { enabled: true, color: 'warm' },
      niche: true,
      twoLevel: true
    }
  },
  modern: {
    name: '✨ Современный',
    description: 'Световые линии и трек',
    config: {
      color: 'white',
      texture: 'matte',
      profile: { back: 'shadow', front: 'shadow', left: 'shadow', right: 'shadow' },
      spots: { enabled: false, count: 6, type: 'round', color: 'black' },
      chandelier: { enabled: false, style: 'minimalist' },
      lightlines: { enabled: true, count: 3, direction: 'along', shape: 'straight' },
      track: { enabled: true, color: 'black' },
      ledStrip: { enabled: false, color: 'warm' },
      niche: false,
      twoLevel: false
    }
  },
  loft: {
    name: '🏭 Лофт',
    description: 'Индустриальный стиль',
    config: {
      color: 'darkgray',
      texture: 'matte',
      profile: { back: 'none', front: 'none', left: 'none', right: 'none' },
      spots: { enabled: false, count: 4, type: 'round', color: 'black' },
      chandelier: { enabled: true, style: 'industrial' },
      lightlines: { enabled: false, count: 1, direction: 'along', shape: 'straight' },
      track: { enabled: true, color: 'black' },
      ledStrip: { enabled: false, color: 'warm' },
      niche: false,
      twoLevel: false
    }
  }
};

// ============ МЕНЮ КОНФИГУРАЦИИ ============

function configMenu(config) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⚡ Пресеты', 'presets'), Markup.button.callback('⭐ Избранное', 'favorites')],
    [Markup.button.callback('🎨 Цвет', 'cfg_color'), Markup.button.callback('✨ Текстура', 'cfg_texture')],
    [Markup.button.callback('📐 Профили', 'cfg_profiles'), Markup.button.callback('🏗 Уровни', 'cfg_levels')],
    [Markup.button.callback('💡 Споты', 'cfg_spots'), Markup.button.callback('🪔 Люстра', 'cfg_chandelier')],
    [Markup.button.callback('📏 Линии', 'cfg_lightlines'), Markup.button.callback('🔦 Трек', 'cfg_track')],
    [Markup.button.callback('💫 LED', 'cfg_led'), Markup.button.callback('🪟 Ниша', 'cfg_niche')],
    [Markup.button.callback('✅ Сгенерировать', 'generate')],
    [Markup.button.callback('💾 Сохранить', 'save_favorite'), Markup.button.callback('🗑 Удалить', 'manage_favorites')],
    [Markup.button.callback('🔄 Сброс', 'reset'), Markup.button.callback('⬅️ Меню', 'back_main')]
  ]);
}

// Меню пресетов
bot.action('presets', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '⚡ *Быстрые пресеты*\n\n' +
    'Выберите готовый стиль потолка:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔲 Минимализм', 'preset_minimalism')],
        [Markup.button.callback('🏛 Классика', 'preset_classic')],
        [Markup.button.callback('💎 Премиум', 'preset_premium')],
        [Markup.button.callback('✨ Современный', 'preset_modern')],
        [Markup.button.callback('🏭 Лофт', 'preset_loft')],
        [Markup.button.callback('⬅️ Назад', 'back_config')]
      ])
    }
  );
});

bot.action(/^preset_(.+)$/, async ctx => {
  const presetKey = ctx.match[1];
  const preset = PRESETS[presetKey];

  if (!preset) {
    return ctx.answerCbQuery('Пресет не найден');
  }

  const state = getState(ctx.from.id);
  state.config = JSON.parse(JSON.stringify(preset.config));

  await ctx.answerCbQuery(`${preset.name} применён!`);
  await ctx.editMessageText(
    `✅ *${preset.name}*\n\n${preset.description}\n\n` + buildSummary(state.config),
    { parse_mode: 'Markdown', ...configMenu(state.config) }
  );
});

bot.action('reset', async ctx => {
  const state = getState(ctx.from.id);
  state.config = getDefaultConfig();
  await ctx.answerCbQuery('Сброшено');
  await ctx.editMessageText('⚙️ *Настройки*\n\n' + buildSummary(state.config), { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ИЗБРАННОЕ ============

bot.action('favorites', async ctx => {
  const userId = ctx.from.id;
  const favorites = await db.getFavorites(userId);

  await ctx.answerCbQuery();

  if (favorites.length === 0) {
    await ctx.editMessageText(
      '⭐ *Избранные конфигурации*\n\n' +
      'У вас пока нет сохранённых конфигураций.\n\n' +
      '_Сохраните текущие настройки, нажав "Сохранить в избранное" в меню настроек._',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back_config')]])
      }
    );
    return;
  }

  const buttons = favorites.slice(0, 10).map(fav => {
    return [Markup.button.callback(`⭐ ${fav.name}`, `load_fav_${fav.id}`)];
  });
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText(
    '⭐ *Избранные конфигурации*\n\n' +
    'Выберите конфигурацию для загрузки:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^load_fav_(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const favId = parseInt(ctx.match[1]);
  const fav = await db.getFavorite(favId, userId);

  if (!fav) {
    return ctx.answerCbQuery('Конфигурация не найдена');
  }

  const state = getState(userId);
  const config = typeof fav.config === 'string' ? JSON.parse(fav.config) : fav.config;
  state.config = JSON.parse(JSON.stringify(config));

  await ctx.answerCbQuery(`${fav.name} загружена!`);
  await ctx.editMessageText(
    `✅ Загружена: *${fav.name}*\n\n` + buildSummary(state.config),
    { parse_mode: 'Markdown', ...configMenu(state.config) }
  );
});

bot.action('save_favorite', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  state.step = 'save_favorite_name';

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '⭐ *Сохранить в избранное*\n\n' +
    'Введите название для этой конфигурации:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'back_config')]])
    }
  );
});

bot.action('manage_favorites', async ctx => {
  const userId = ctx.from.id;
  const favorites = await db.getFavorites(userId);

  await ctx.answerCbQuery();

  if (favorites.length === 0) {
    await ctx.editMessageText(
      '⭐ *Управление избранным*\n\nНет сохранённых конфигураций.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back_config')]])
      }
    );
    return;
  }

  const buttons = favorites.slice(0, 10).map(fav => {
    return [Markup.button.callback(`🗑 ${fav.name}`, `del_fav_${fav.id}`)];
  });
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText(
    '⭐ *Управление избранным*\n\n' +
    'Нажмите для удаления:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

bot.action(/^del_fav_(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const favId = parseInt(ctx.match[1]);

  await db.deleteFavorite(favId, userId);
  await ctx.answerCbQuery('Удалено');

  // Обновляем список
  const favorites = await db.getFavorites(userId);

  if (favorites.length === 0) {
    await ctx.editMessageText(
      '⭐ *Управление избранным*\n\nНет сохранённых конфигураций.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back_config')]])
      }
    );
    return;
  }

  const buttons = favorites.slice(0, 10).map(fav => {
    return [Markup.button.callback(`🗑 ${fav.name}`, `del_fav_${fav.id}`)];
  });
  buttons.push([Markup.button.callback('⬅️ Назад', 'back_config')]);

  await ctx.editMessageText(
    '⭐ *Управление избранным*\n\n' +
    'Нажмите для удаления:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  );
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

// Функция обновления статуса с прогрессом
async function updateProgress(ctx, msgId, step, total = 4) {
  const steps = [
    '📤 Загружаю фото...',
    '🎨 Анализирую помещение...',
    '✨ Генерирую потолок...',
    '🖼 Обрабатываю результат...'
  ];
  const progress = '▓'.repeat(step) + '░'.repeat(total - step);
  const text = `${steps[step - 1]}\n\n[${progress}] ${Math.round(step / total * 100)}%`;

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text);
  } catch (e) {}
}

// Сохранение последней генерации для перегенерации
function saveLastGeneration(userId, config, resultUrl) {
  const state = getState(userId);
  state.lastGeneration = {
    config: JSON.parse(JSON.stringify(config)),
    resultUrl,
    timestamp: Date.now()
  };
}

bot.action('generate', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const user = await db.getUser(userId);

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

  const statusMsg = await ctx.reply('📤 Загружаю фото...\n\n[░░░░] 0%');

  try {
    // Шаг 1: Подготовка изображения
    await updateProgress(ctx, statusMsg.message_id, 1);

    const resizedImage = await sharp(state.photo)
      .resize(1536, 1536, { fit: 'inside' })  // Увеличили разрешение для лучшего качества
      .jpeg({ quality: 95 })  // Повысили качество
      .toBuffer();

    const base64Image = `data:image/jpeg;base64,${resizedImage.toString('base64')}`;

    // Шаг 2: Анализ
    await updateProgress(ctx, statusMsg.message_id, 2);

    const prompt = buildPrompt(state.config);
    console.log(`[${userId}] Prompt: ${prompt}`);

    // Шаг 3: Генерация
    await updateProgress(ctx, statusMsg.message_id, 3);

    const output = await replicate.run("black-forest-labs/flux-kontext-max", {
      input: {
        prompt,
        input_image: base64Image,
        aspect_ratio: "match_input_image",
        safety_tolerance: 6,
        output_format: "jpg",
        output_quality: 95
      }
    });

    // Шаг 4: Обработка результата
    await updateProgress(ctx, statusMsg.message_id, 4);

    const resultUrl = Array.isArray(output) ? output[0] : output;
    console.log(`[${userId}] Done: ${resultUrl}`);

    // Списание (кроме админов)
    if (!isAdmin(userId) && user) {
      await db.updateUser(userId, { balance: user.balance - GENERATION_COST });
      await db.addTransaction(userId, -GENERATION_COST, 'generation', 'Генерация визуализации');
    }

    // Сохраняем генерацию с URL результата
    await db.addGeneration(userId, state.config, resultUrl);
    saveLastGeneration(userId, state.config, resultUrl);

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    const newBalance = isAdmin(userId) ? '∞' : (user.balance - GENERATION_COST);

    await ctx.replyWithPhoto({ url: resultUrl }, {
      caption: '✅ *Готово!*\n\n' + buildSummary(state.config) +
        `\n\n💰 Баланс: ${newBalance} ₽` +
        '\n\n💡 _Покажите клиенту — пусть оценит будущий потолок!_',
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Перегенерировать (75₽)', 'regenerate')],
        [Markup.button.callback('⚙️ Изменить настройки', 'back_config')],
        [Markup.button.callback('📸 Новое фото', 'new_visual')],
        [Markup.button.callback('🏠 Меню', 'back_main')]
      ])
    });

  } catch (e) {
    console.error(`[${userId}] Error:`, e.message || e);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply('❌ Ошибка генерации. Попробуйте снова или выберите другие настройки.',
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Попробовать снова', 'generate')],
        [Markup.button.callback('⚙️ Изменить настройки', 'back_config')],
        [Markup.button.callback('🏠 Меню', 'back_main')]
      ])
    );
  } finally {
    state.processing = false;
  }
});

// Перегенерация с теми же настройками
bot.action('regenerate', async ctx => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const user = await db.getUser(userId);

  if (!state.photo) {
    await ctx.answerCbQuery();
    return ctx.reply(
      '📸 *Фото не найдено*\n\n' +
      'Для перегенерации нужно загрузить фото заново.\n' +
      '_Это происходит после перезапуска бота или долгого перерыва._',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📸 Загрузить фото', 'new_visual')],
          [Markup.button.callback('🏠 Меню', 'back_main')]
        ])
      }
    );
  }

  if (state.processing) {
    return ctx.answerCbQuery('Подождите...');
  }

  // Проверка доступа
  if (!isAdmin(userId)) {
    if (!user) return ctx.answerCbQuery('Нет доступа');
    if (user.balance < GENERATION_COST) {
      return ctx.answerCbQuery(`Недостаточно средств. Нужно ${GENERATION_COST} ₽`);
    }
  }

  state.processing = true;
  await ctx.answerCbQuery('Генерирую новый вариант...');

  const statusMsg = await ctx.reply('🔄 Генерирую новый вариант...\n\n[░░░░] 0%');

  try {
    await updateProgress(ctx, statusMsg.message_id, 1);

    const resizedImage = await sharp(state.photo)
      .resize(1536, 1536, { fit: 'inside' })
      .jpeg({ quality: 95 })
      .toBuffer();

    const base64Image = `data:image/jpeg;base64,${resizedImage.toString('base64')}`;

    await updateProgress(ctx, statusMsg.message_id, 2);

    const prompt = buildPrompt(state.config);

    await updateProgress(ctx, statusMsg.message_id, 3);

    const output = await replicate.run("black-forest-labs/flux-kontext-max", {
      input: {
        prompt,
        input_image: base64Image,
        aspect_ratio: "match_input_image",
        safety_tolerance: 6,
        output_format: "jpg",
        output_quality: 95
      }
    });

    await updateProgress(ctx, statusMsg.message_id, 4);

    const resultUrl = Array.isArray(output) ? output[0] : output;

    if (!isAdmin(userId) && user) {
      await db.updateUser(userId, { balance: user.balance - GENERATION_COST });
      await db.addTransaction(userId, -GENERATION_COST, 'generation', 'Перегенерация');
    }

    await db.addGeneration(userId, state.config, resultUrl);
    saveLastGeneration(userId, state.config, resultUrl);

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    const newBalance = isAdmin(userId) ? '∞' : (user.balance - GENERATION_COST);

    await ctx.replyWithPhoto({ url: resultUrl }, {
      caption: '✅ *Новый вариант готов!*\n\n' + buildSummary(state.config) +
        `\n\n💰 Баланс: ${newBalance} ₽`,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Ещё вариант (75₽)', 'regenerate')],
        [Markup.button.callback('⚙️ Изменить настройки', 'back_config')],
        [Markup.button.callback('📸 Новое фото', 'new_visual')],
        [Markup.button.callback('🏠 Меню', 'back_main')]
      ])
    });

  } catch (e) {
    console.error(`[${userId}] Regenerate error:`, e.message || e);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply('❌ Ошибка. Попробуйте снова.');
  } finally {
    state.processing = false;
  }
});

// ============ YOOKASSA ПЛАТЕЖИ ============

// Создание платежа в YooKassa
async function createYooKassaPayment(userId, amount, generations, paymentType, distribution = null) {
  if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
    console.log('YooKassa not configured, using test mode');
    return null;
  }

  const idempotenceKey = uuidv4();
  const paymentId = uuidv4();

  const paymentData = {
    amount: {
      value: amount.toFixed(2),
      currency: 'RUB'
    },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: `https://t.me/${process.env.BOT_USERNAME || 'potolki_ai_bot'}`
    },
    description: `Пополнение баланса: ${generations} генераций`,
    metadata: {
      userId: userId.toString(),
      generations: generations,
      paymentType: paymentType,
      distribution: distribution ? JSON.stringify(distribution) : null
    }
  };

  try {
    const response = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      paymentData,
      {
        auth: {
          username: YOOKASSA_SHOP_ID,
          password: YOOKASSA_SECRET_KEY
        },
        headers: {
          'Idempotence-Key': idempotenceKey,
          'Content-Type': 'application/json'
        }
      }
    );

    // Сохраняем информацию о платеже
    pendingPayments.set(response.data.id, {
      oderId: paymentId,
      userId: userId,
      amount: amount,
      generations: generations,
      paymentType: paymentType,
      distribution: distribution,
      createdAt: new Date().toISOString()
    });

    return response.data;
  } catch (error) {
    console.error('YooKassa payment error:', error.response?.data || error.message);
    return null;
  }
}

// Webhook для получения уведомлений от YooKassa
app.post('/yookassa-webhook', async (req, res) => {
  try {
    const notification = req.body;

    if (notification.event === 'payment.succeeded') {
      const payment = notification.object;
      const metadata = payment.metadata;

      if (metadata && metadata.userId) {
        const userId = parseInt(metadata.userId);
        const generations = parseInt(metadata.generations);
        const amount = parseFloat(payment.amount.value);
        const paymentType = metadata.paymentType;

        if (paymentType === 'company' && metadata.distribution) {
          // Распределение по сотрудникам
          const distribution = JSON.parse(metadata.distribution);

          for (const [empId, gens] of Object.entries(distribution)) {
            const empUser = await db.getUser(empId);
            if (empUser) {
              const addAmount = gens * GENERATION_COST;
              await db.updateUser(empId, { balance: (empUser.balance || 0) + addAmount });
              await db.addTransaction(empId, addAmount, 'topup', 'Пополнение от компании');

              try {
                await bot.telegram.sendMessage(empId,
                  `💰 Ваш баланс пополнен на ${addAmount} ₽ (${gens} генераций)\n\nТекущий баланс: ${empUser.balance + addAmount} ₽`
                );
              } catch (e) {}
            }
          }

          // Уведомляем плательщика
          try {
            await bot.telegram.sendMessage(userId,
              `✅ Оплата ${amount} ₽ прошла успешно!\n\n` +
              `Средства распределены между сотрудниками.`
            );
          } catch (e) {}
        } else {
          // Личное пополнение
          const user = await db.getUser(userId);
          if (user) {
            const genAmount = generations * GENERATION_COST;
            await db.updateUser(userId, { balance: (user.balance || 0) + genAmount });
            await db.addTransaction(userId, genAmount, 'topup', 'Пополнение через YooKassa');

            try {
              await bot.telegram.sendMessage(userId,
                `✅ Оплата ${amount} ₽ прошла успешно!\n\n` +
                `💰 Баланс пополнен на ${genAmount} ₽\n` +
                `🖼 Доступно генераций: ${Math.floor((user.balance + genAmount) / GENERATION_COST)}`
              );
            } catch (e) {}
          }
        }

        // Удаляем из ожидающих
        pendingPayments.delete(payment.id);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
});

// Проверка статуса платежа
app.get('/payment-status/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  const pending = pendingPayments.get(paymentId);

  if (pending) {
    res.json({ status: 'pending', ...pending });
  } else {
    res.json({ status: 'unknown' });
  }
});

// ============ КНОПКА ОПЛАТЫ ============

bot.action('pay_balance', async ctx => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);

  if (!user && !isAdmin(userId)) {
    return ctx.answerCbQuery('Нет доступа');
  }

  await ctx.answerCbQuery();

  // Показываем информацию об оплате
  let text = '💳 *Пополнение баланса*\n\n';
  text += `📊 Стоимость 1 генерации: ${GENERATION_COST} ₽\n\n`;

  if (user) {
    text += `💰 Ваш баланс: ${user.balance || 0} ₽\n`;
    text += `🖼 Доступно генераций: ${Math.floor((user.balance || 0) / GENERATION_COST)}\n\n`;
  }

  text += '📋 *Тарифы:*\n';
  text += '• 1 генерация — 75 ₽\n';
  text += '• 5 генераций — 375 ₽\n';
  text += '• 10 генераций — 750 ₽\n';
  text += '• 20 генераций — 1 500 ₽\n';
  text += '• 40 генераций — 3 000 ₽\n\n';

  const buttons = [];

  if (YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY && PAYMENT_WEBHOOK_URL) {
    // YooKassa настроена - показываем WebApp
    const webAppUrl = PAYMENT_WEBHOOK_URL.replace('/yookassa-webhook', '/payment.html');

    // Проверяем, есть ли у пользователя сотрудники (для компании)
    let startParam = '';
    if (user) {
      const companyUsers = await db.getCompanyUsers(user.company_id).filter(u => u.id != userId);
      if (companyUsers.length > 0) {
        const employeesData = companyUsers.map(u => ({ id: u.id.toString(), name: u.name || 'Сотрудник' }));
        startParam = Buffer.from(JSON.stringify({ employees: employeesData })).toString('base64');
      }
    }

    text += '✅ Оплата через YooKassa';
    buttons.push([Markup.button.webApp('💳 Перейти к оплате', webAppUrl + (startParam ? `?data=${startParam}` : ''))]);
  } else {
    // YooKassa не настроена - показываем быстрые кнопки для тестирования
    text += '⚠️ _Система оплаты в процессе настройки_\n';
    text += 'Выберите сумму для создания счёта:';

    buttons.push([
      Markup.button.callback('375 ₽ (5 ген.)', 'create_invoice_375'),
      Markup.button.callback('750 ₽ (10 ген.)', 'create_invoice_750')
    ]);
    buttons.push([
      Markup.button.callback('1500 ₽ (20 ген.)', 'create_invoice_1500'),
      Markup.button.callback('3000 ₽ (40 ген.)', 'create_invoice_3000')
    ]);
  }

  buttons.push([Markup.button.callback('⬅️ Назад', 'back_main')]);

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  } catch (e) {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  }
});

// Обработка создания счёта (тестовый режим)
bot.action(/^create_invoice_(\d+)$/, async ctx => {
  const userId = ctx.from.id;
  const amount = parseInt(ctx.match[1]);
  const generations = Math.floor(amount / GENERATION_COST);

  await ctx.answerCbQuery();

  await ctx.editMessageText(
    `📝 *Счёт на оплату*\n\n` +
    `💰 Сумма: ${amount} ₽\n` +
    `🖼 Генераций: ${generations}\n\n` +
    `⚠️ _Для подключения онлайн-оплаты необходимо настроить YooKassa_\n\n` +
    `Для ручного пополнения обратитесь к администратору.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Назад', 'pay_balance')]
      ])
    }
  );
});

// Обработка данных из WebApp
bot.on('web_app_data', async ctx => {
  try {
    const data = JSON.parse(ctx.message.web_app_data.data);
    const userId = ctx.from.id;

    if (data.action === 'payment') {
      const { amount, generations, type, distribution } = data;

      // Создаём платёж в YooKassa
      const payment = await createYooKassaPayment(userId, amount, generations, type, distribution);

      if (payment && payment.confirmation?.confirmation_url) {
        await ctx.reply(
          `💳 *Оплата ${amount} ₽*\n\n` +
          `🖼 Генераций: ${generations}\n\n` +
          'Нажмите кнопку для перехода к оплате:',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.url('💳 Перейти к оплате', payment.confirmation.confirmation_url)],
              [Markup.button.callback('❌ Отмена', 'back_main')]
            ])
          }
        );
      } else {
        // Тестовый режим или ошибка
        await ctx.reply(
          '⚠️ Система оплаты временно недоступна.\n\n' +
          'Обратитесь к администратору для пополнения баланса.',
          persistentKeyboard(isAdmin(userId))
        );
      }
    }
  } catch (error) {
    console.error('WebApp data error:', error);
    await ctx.reply('❌ Ошибка обработки платежа');
  }
});

// ============ ЗАПУСК ============

// Запуск Express сервера
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🌐 Webhook сервер запущен на порту ${PORT}`);
});

bot.launch().then(() => {
  console.log('🚀 Бот запущен');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
