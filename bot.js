require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ADMIN_IDS = process.env.ADMIN_IDS?.split(',').map(id => parseInt(id.trim())) || [];
const PRICE_RUB = 50;
const DATA_FILE = path.join(__dirname, 'data.json');

// ============ ДАННЫЕ ============
function loadData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
  return { companies: {}, individuals: {}, users: {}, totalGenerations: 0, totalRevenue: 0 };
}
function saveData() { fs.writeFileSync(DATA_FILE, JSON.stringify(appData, null, 2)); }
let appData = loadData();
const userStates = new Map();

function isAdmin(userId) { return ADMIN_IDS.includes(userId); }
function getUser(userId) { return appData.users[userId.toString()]; }
function isAllowedUser(userId) { return isAdmin(userId) || getUser(userId); }

function getUserBalance(userId) {
  const user = getUser(userId);
  if (!user) return 0;
  if (user.companyId) return appData.companies[user.companyId]?.balance || 0;
  return appData.individuals[userId.toString()]?.balance || 0;
}

function deductBalance(userId, amount) {
  const user = getUser(userId);
  if (!user) return false;
  if (user.companyId) {
    const comp = appData.companies[user.companyId];
    if (comp && comp.balance >= amount) { comp.balance -= amount; saveData(); return true; }
  } else {
    const ind = appData.individuals[userId.toString()];
    if (ind && ind.balance >= amount) { ind.balance -= amount; saveData(); return true; }
  }
  return false;
}

// ============ КОНФИГУРАЦИЯ ============
function getDefaultConfig() {
  return {
    color: 'white',
    texture: 'matte',
    levels: 'single',
    profiles: { top: 'standard', right: 'standard', bottom: 'standard', left: 'standard' },
    spots: { enabled: false, count: 6, layout: 'grid' },
    chandelier: { enabled: false, style: 'modern' },
    lightLines: { enabled: false, count: 1, direction: 'along' },
    cornice: { enabled: false }
  };
}

function getState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      photo: null,
      step: 'idle',
      processing: false,
      config: getDefaultConfig(),
      adminMode: null,
      tempData: {}
    });
  }
  return userStates.get(userId);
}

// ============ СЛОВАРИ ============
const COLORS = {
  white: { label: '⬜ Белый', en: 'white' },
  beige: { label: '🟨 Бежевый', en: 'beige' },
  gray: { label: '⬛ Серый', en: 'gray' },
  black: { label: '🖤 Чёрный', en: 'black' }
};

const TEXTURES = {
  matte: { label: '🎨 Матовый', en: 'matte' },
  glossy: { label: '✨ Глянцевый', en: 'glossy' },
  satin: { label: '🌟 Сатиновый', en: 'satin' }
};

const PROFILES = {
  standard: { label: '➖ Обычный' },
  shadow: { label: '🔲 Теневой' },
  floating: { label: '💫 Парящий' }
};

const SPOT_LAYOUTS = {
  grid: { label: '⊞ Сеткой' },
  perimeter: { label: '⬚ По периметру' },
  center: { label: '⊙ В центре' }
};

const CHANDELIER_STYLES = {
  modern: { label: '🔘 Современная' },
  classic: { label: '🏛 Классическая' },
  crystal: { label: '💎 Хрустальная' }
};

const WALL_NAMES = { top: '⬆️ Дальняя', right: '➡️ Правая', bottom: '⬇️ Ближняя', left: '⬅️ Левая' };

// ============ ПОСТРОЕНИЕ ПРОМПТОВ ============

function buildFullPrompt(config) {
  const color = COLORS[config.color]?.en || 'white';

  let textureDesc = '';
  if (config.texture === 'glossy') {
    textureDesc = 'glossy mirror-like reflective lacquered surface that reflects the room below';
  } else if (config.texture === 'satin') {
    textureDesc = 'satin pearl-like finish with subtle soft sheen';
  } else {
    textureDesc = 'matte flat finish like painted drywall';
  }

  let prompt = `Edit only the ceiling in this room photo. Replace the existing ceiling with a modern stretch ceiling.

The NEW ceiling must be:
- Solid ${color} color with ${textureDesc}
- Perfectly flat and smooth from wall to wall
- Professional stretch ceiling installation look

`;

  const elements = [];

  // Профили по стенам
  const wallMap = { top: 'far/back', right: 'right', bottom: 'near/front', left: 'left' };

  for (const [wall, wallName] of Object.entries(wallMap)) {
    const profile = config.profiles[wall];
    if (profile === 'shadow') {
      elements.push(`Add a thin black shadow gap (1cm) where ceiling meets the ${wallName} wall`);
    } else if (profile === 'floating') {
      elements.push(`Add white LED strip lighting at the junction of ceiling and ${wallName} wall creating a floating effect`);
    }
  }

  // Споты
  if (config.spots.enabled) {
    const count = config.spots.count;
    let layout = '';
    if (config.spots.layout === 'grid') {
      if (count === 4) layout = 'in 2x2 grid pattern';
      else if (count === 6) layout = 'in 2x3 grid pattern';
      else if (count === 8) layout = 'in 2x4 grid pattern';
      else if (count === 10) layout = 'in 2x5 grid pattern';
      else if (count === 12) layout = 'in 3x4 grid pattern';
      else layout = 'evenly distributed';
    } else if (config.spots.layout === 'perimeter') {
      layout = 'around the perimeter of the ceiling';
    } else {
      layout = 'clustered in the center area';
    }
    elements.push(`Add ${count} small round LED spotlights (5-7cm diameter) recessed into the ceiling, ${layout}. All lights are ON and glowing`);
  }

  // Люстра
  if (config.chandelier.enabled) {
    let style = 'modern minimalist pendant lamp with white shade';
    if (config.chandelier.style === 'classic') style = 'elegant classic chandelier with multiple arms and shades';
    else if (config.chandelier.style === 'crystal') style = 'luxurious crystal chandelier with hanging crystals';
    elements.push(`Add a ${style} hanging from the center of the ceiling. The light is ON`);
  }

  // Световые линии
  if (config.lightLines.enabled) {
    let dir = 'running lengthwise along the room';
    if (config.lightLines.direction === 'across') dir = 'running across the width of the room';
    else if (config.lightLines.direction === 'diagonal') dir = 'running diagonally';
    elements.push(`Add ${config.lightLines.count} bright white LED light line(s) built into the ceiling, ${dir}`);
  }

  // Карниз для штор
  if (config.cornice.enabled) {
    elements.push(`Add a recessed niche near the window for hidden curtain rod - a dark rectangular gap in the ceiling parallel to the window wall`);
  }

  if (elements.length > 0) {
    prompt += `Add these lighting elements:\n`;
    elements.forEach((el, i) => {
      prompt += `${i + 1}. ${el}\n`;
    });
  }

  prompt += `
IMPORTANT RULES:
- Keep the ceiling FLAT - no multiple levels, no 3D structures
- Do NOT add air conditioning or ventilation
- Keep all walls, floor, furniture, doors, windows exactly as they are
- Only modify the ceiling area`;

  return prompt;
}

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============
function buildSummary(config) {
  let summary = `🎨 Цвет: ${COLORS[config.color]?.label}\n`;
  summary += `✨ Текстура: ${TEXTURES[config.texture]?.label}\n`;

  // Профили
  const profileParts = [];
  for (const [wall, profile] of Object.entries(config.profiles)) {
    if (profile !== 'standard') {
      profileParts.push(`${WALL_NAMES[wall]}: ${PROFILES[profile]?.label}`);
    }
  }
  if (profileParts.length > 0) {
    summary += `📐 Профили: ${profileParts.join(', ')}\n`;
  }

  if (config.spots.enabled) {
    summary += `💡 Споты: ${config.spots.count} шт (${SPOT_LAYOUTS[config.spots.layout]?.label})\n`;
  }
  if (config.chandelier.enabled) {
    summary += `🏮 Люстра: ${CHANDELIER_STYLES[config.chandelier.style]?.label}\n`;
  }
  if (config.lightLines.enabled) {
    summary += `📏 Световые линии: ${config.lightLines.count} шт\n`;
  }
  if (config.cornice.enabled) {
    summary += `🪟 Карниз: скрытый\n`;
  }

  return summary;
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎨 Цвет потолка', 'menu_color')],
    [Markup.button.callback('✨ Текстура', 'menu_texture')],
    [Markup.button.callback('📐 Профили по стенам', 'menu_profiles')],
    [Markup.button.callback('💡 Точечные светильники', 'menu_spots')],
    [Markup.button.callback('🏮 Люстра', 'menu_chandelier')],
    [Markup.button.callback('📏 Световые линии', 'menu_lines')],
    [Markup.button.callback('🪟 Карниз для штор', 'menu_cornice')],
    [Markup.button.callback('🚀 СГЕНЕРИРОВАТЬ', 'generate')]
  ]);
}

// ============ КОМАНДЫ ============
bot.command('start', async ctx => {
  if (!isAllowedUser(ctx.from.id)) {
    return ctx.reply('⛔ Доступ запрещён. Обратитесь к администратору.');
  }

  const state = getState(ctx.from.id);
  state.step = 'awaiting_photo';
  state.config = getDefaultConfig();
  state.photo = null;

  await ctx.reply(
    '👋 *Визуализатор натяжных потолков*\n\n📸 Отправьте фото помещения для начала работы.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('start', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  state.step = 'awaiting_photo';
  state.config = getDefaultConfig();
  state.photo = null;

  await ctx.reply(
    '📸 *Отправьте фото помещения*\n\nФото должно чётко показывать потолок.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('menu', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);

  if (!state.photo) {
    return ctx.reply('Сначала отправьте фото!');
  }

  const summary = buildSummary(state.config);
  await ctx.reply(
    `⚙️ *Настройки потолка*\n\n${summary}\n📍 Выберите параметр для изменения:`,
    { parse_mode: 'Markdown', ...mainMenuKeyboard() }
  );
});

// ============ ФОТО ============
bot.on('photo', async ctx => {
  if (!isAllowedUser(ctx.from.id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }

  const state = getState(ctx.from.id);

  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });

    state.photo = Buffer.from(response.data);
    state.config = getDefaultConfig();

    const summary = buildSummary(state.config);

    await ctx.reply(
      `✅ *Фото получено!*\n\n${summary}\n📍 Настройте параметры и нажмите "Сгенерировать":`,
      { parse_mode: 'Markdown', ...mainMenuKeyboard() }
    );
  } catch (error) {
    console.error('Photo error:', error);
    await ctx.reply('❌ Ошибка загрузки фото. Попробуйте ещё раз.');
  }
});

// ============ МЕНЮ ЦВЕТА ============
bot.action('menu_color', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('🎨 *Выберите цвет потолка:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⬜ Белый', 'color_white'), Markup.button.callback('🟨 Бежевый', 'color_beige')],
      [Markup.button.callback('⬛ Серый', 'color_gray'), Markup.button.callback('🖤 Чёрный', 'color_black')],
      [Markup.button.callback('« Назад', 'menu')]
    ])
  });
});

bot.action(/^color_(.+)$/, async ctx => {
  const color = ctx.match[1];
  const state = getState(ctx.from.id);
  state.config.color = color;
  await ctx.answerCbQuery(`Цвет: ${COLORS[color]?.label}`);

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Цвет изменён!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

// ============ МЕНЮ ТЕКСТУРЫ ============
bot.action('menu_texture', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('✨ *Выберите текстуру:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🎨 Матовый', 'texture_matte')],
      [Markup.button.callback('✨ Глянцевый', 'texture_glossy')],
      [Markup.button.callback('🌟 Сатиновый', 'texture_satin')],
      [Markup.button.callback('« Назад', 'menu')]
    ])
  });
});

bot.action(/^texture_(.+)$/, async ctx => {
  const texture = ctx.match[1];
  const state = getState(ctx.from.id);
  state.config.texture = texture;
  await ctx.answerCbQuery(`Текстура: ${TEXTURES[texture]?.label}`);

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Текстура изменена!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

// ============ МЕНЮ ПРОФИЛЕЙ ============
bot.action('menu_profiles', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);

  const buttons = Object.entries(WALL_NAMES).map(([wall, name]) => {
    const profile = state.config.profiles[wall];
    const profileLabel = PROFILES[profile]?.label || '➖';
    return [Markup.button.callback(`${name}: ${profileLabel}`, `profile_wall_${wall}`)];
  });
  buttons.push([Markup.button.callback('« Назад', 'menu')]);

  await ctx.reply(
    '📐 *Профили по стенам*\n\n_Выберите стену для настройки:_\n\n' +
    '🔲 Теневой - тёмная линия на стыке\n💫 Парящий - подсветка LED',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action(/^profile_wall_(.+)$/, async ctx => {
  const wall = ctx.match[1];
  await ctx.answerCbQuery();

  await ctx.reply(`📐 *Профиль для стены ${WALL_NAMES[wall]}:*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➖ Обычный', `set_profile_${wall}_standard`)],
      [Markup.button.callback('🔲 Теневой', `set_profile_${wall}_shadow`)],
      [Markup.button.callback('💫 Парящий', `set_profile_${wall}_floating`)],
      [Markup.button.callback('« Назад', 'menu_profiles')]
    ])
  });
});

bot.action(/^set_profile_(.+)_(.+)$/, async ctx => {
  const wall = ctx.match[1];
  const profile = ctx.match[2];
  const state = getState(ctx.from.id);
  state.config.profiles[wall] = profile;
  await ctx.answerCbQuery(`${WALL_NAMES[wall]}: ${PROFILES[profile]?.label}`);

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Профиль изменён!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

// ============ МЕНЮ СПОТОВ ============
bot.action('menu_spots', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);

  const status = state.config.spots.enabled
    ? `Включены: ${state.config.spots.count} шт, ${SPOT_LAYOUTS[state.config.spots.layout]?.label}`
    : 'Выключены';

  await ctx.reply(`💡 *Точечные светильники*\n\nСтатус: ${status}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(state.config.spots.enabled ? '❌ Выключить' : '✅ Включить', 'spots_toggle')],
      [Markup.button.callback('🔢 Количество', 'spots_count'), Markup.button.callback('📍 Расположение', 'spots_layout')],
      [Markup.button.callback('« Назад', 'menu')]
    ])
  });
});

bot.action('spots_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.enabled = !state.config.spots.enabled;
  await ctx.answerCbQuery(state.config.spots.enabled ? 'Споты включены' : 'Споты выключены');

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Настройки изменены!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

bot.action('spots_count', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('🔢 *Количество спотов:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('4', 'set_spots_4'), Markup.button.callback('6', 'set_spots_6')],
      [Markup.button.callback('8', 'set_spots_8'), Markup.button.callback('10', 'set_spots_10')],
      [Markup.button.callback('12', 'set_spots_12')],
      [Markup.button.callback('« Назад', 'menu_spots')]
    ])
  });
});

bot.action(/^set_spots_(\d+)$/, async ctx => {
  const count = parseInt(ctx.match[1]);
  const state = getState(ctx.from.id);
  state.config.spots.count = count;
  state.config.spots.enabled = true;
  await ctx.answerCbQuery(`Споты: ${count} шт`);

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Количество изменено!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

bot.action('spots_layout', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('📍 *Расположение спотов:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⊞ Сеткой', 'set_layout_grid')],
      [Markup.button.callback('⬚ По периметру', 'set_layout_perimeter')],
      [Markup.button.callback('⊙ В центре', 'set_layout_center')],
      [Markup.button.callback('« Назад', 'menu_spots')]
    ])
  });
});

bot.action(/^set_layout_(.+)$/, async ctx => {
  const layout = ctx.match[1];
  const state = getState(ctx.from.id);
  state.config.spots.layout = layout;
  await ctx.answerCbQuery(`Расположение: ${SPOT_LAYOUTS[layout]?.label}`);

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Расположение изменено!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

// ============ МЕНЮ ЛЮСТРЫ ============
bot.action('menu_chandelier', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);

  const status = state.config.chandelier.enabled
    ? `Включена: ${CHANDELIER_STYLES[state.config.chandelier.style]?.label}`
    : 'Выключена';

  await ctx.reply(`🏮 *Люстра*\n\nСтатус: ${status}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(state.config.chandelier.enabled ? '❌ Выключить' : '✅ Включить', 'chandelier_toggle')],
      [Markup.button.callback('🎨 Стиль', 'chandelier_style')],
      [Markup.button.callback('« Назад', 'menu')]
    ])
  });
});

bot.action('chandelier_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.chandelier.enabled = !state.config.chandelier.enabled;
  await ctx.answerCbQuery(state.config.chandelier.enabled ? 'Люстра включена' : 'Люстра выключена');

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Настройки изменены!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

bot.action('chandelier_style', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('🎨 *Стиль люстры:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔘 Современная', 'set_chandelier_modern')],
      [Markup.button.callback('🏛 Классическая', 'set_chandelier_classic')],
      [Markup.button.callback('💎 Хрустальная', 'set_chandelier_crystal')],
      [Markup.button.callback('« Назад', 'menu_chandelier')]
    ])
  });
});

bot.action(/^set_chandelier_(.+)$/, async ctx => {
  const style = ctx.match[1];
  const state = getState(ctx.from.id);
  state.config.chandelier.style = style;
  state.config.chandelier.enabled = true;
  await ctx.answerCbQuery(`Стиль: ${CHANDELIER_STYLES[style]?.label}`);

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Стиль изменён!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

// ============ МЕНЮ СВЕТОВЫХ ЛИНИЙ ============
bot.action('menu_lines', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);

  const status = state.config.lightLines.enabled
    ? `Включены: ${state.config.lightLines.count} шт`
    : 'Выключены';

  await ctx.reply(`📏 *Световые линии*\n\nСтатус: ${status}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(state.config.lightLines.enabled ? '❌ Выключить' : '✅ Включить', 'lines_toggle')],
      [Markup.button.callback('🔢 Количество', 'lines_count')],
      [Markup.button.callback('« Назад', 'menu')]
    ])
  });
});

bot.action('lines_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightLines.enabled = !state.config.lightLines.enabled;
  await ctx.answerCbQuery(state.config.lightLines.enabled ? 'Линии включены' : 'Линии выключены');

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Настройки изменены!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

bot.action('lines_count', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('🔢 *Количество линий:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('1', 'set_lines_1'), Markup.button.callback('2', 'set_lines_2'), Markup.button.callback('3', 'set_lines_3')],
      [Markup.button.callback('« Назад', 'menu_lines')]
    ])
  });
});

bot.action(/^set_lines_(\d+)$/, async ctx => {
  const count = parseInt(ctx.match[1]);
  const state = getState(ctx.from.id);
  state.config.lightLines.count = count;
  state.config.lightLines.enabled = true;
  await ctx.answerCbQuery(`Линий: ${count}`);

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Количество изменено!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

// ============ МЕНЮ КАРНИЗА ============
bot.action('menu_cornice', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);

  await ctx.reply(`🪟 *Карниз для штор*\n\nСтатус: ${state.config.cornice.enabled ? 'Включён' : 'Выключен'}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(state.config.cornice.enabled ? '❌ Выключить' : '✅ Включить', 'cornice_toggle')],
      [Markup.button.callback('« Назад', 'menu')]
    ])
  });
});

bot.action('cornice_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.cornice.enabled = !state.config.cornice.enabled;
  await ctx.answerCbQuery(state.config.cornice.enabled ? 'Карниз включён' : 'Карниз выключён');

  const summary = buildSummary(state.config);
  await ctx.reply(`✅ Настройки изменены!\n\n${summary}`, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

// ============ ГЕНЕРАЦИЯ ЧЕРЕЗ OPENAI ============
bot.action('generate', async ctx => {
  const state = getState(ctx.from.id);
  const userId = ctx.from.id;

  if (!state.photo) return ctx.answerCbQuery('Сначала отправьте фото!');
  if (state.processing) return ctx.answerCbQuery('Уже генерируется...');

  const bal = getUserBalance(userId);
  if (bal < PRICE_RUB && !isAdmin(userId)) return ctx.answerCbQuery('Недостаточно средств!');

  state.processing = true;
  await ctx.answerCbQuery('Запускаю генерацию...');

  const summary = buildSummary(state.config);
  let statusMsg = await ctx.reply('⏳ *Генерация изображения...*\n\n_Использую OpenAI gpt-image-1 (обычно 30-90 сек)_', { parse_mode: 'Markdown' });

  try {
    const prompt = buildFullPrompt(state.config);
    console.log(`[${userId}] === OPENAI GENERATION ===`);
    console.log(`[${userId}] Prompt: ${prompt}`);

    // Сохраняем фото во временный файл
    const tempFilePath = path.join(__dirname, `temp_${userId}.png`);
    fs.writeFileSync(tempFilePath, state.photo);

    // Вызываем OpenAI Images Edit API
    const response = await openai.images.edit({
      model: "gpt-image-1",
      image: fs.createReadStream(tempFilePath),
      prompt: prompt,
      n: 1,
      size: "1024x1024"
    });

    // Удаляем временный файл
    fs.unlinkSync(tempFilePath);

    console.log(`[${userId}] OpenAI response:`, JSON.stringify(response, null, 2));

    // Получаем результат
    let imageData;
    if (response.data && response.data[0]) {
      if (response.data[0].url) {
        imageData = { url: response.data[0].url };
      } else if (response.data[0].b64_json) {
        // Если вернулся base64, сохраняем и отправляем как файл
        const resultBuffer = Buffer.from(response.data[0].b64_json, 'base64');
        const resultPath = path.join(__dirname, `result_${userId}.png`);
        fs.writeFileSync(resultPath, resultBuffer);
        imageData = { source: resultPath };
      }
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    if (imageData) {
      if (imageData.url) {
        await ctx.replyWithPhoto({ url: imageData.url }, {
          caption: `✅ *Готово!*\n\n${summary}`,
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Изменить настройки', 'menu')],
            [Markup.button.callback('📸 Новое фото', 'start')]
          ])
        });
      } else if (imageData.source) {
        await ctx.replyWithPhoto({ source: imageData.source }, {
          caption: `✅ *Готово!*\n\n${summary}`,
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Изменить настройки', 'menu')],
            [Markup.button.callback('📸 Новое фото', 'start')]
          ])
        });
        // Удаляем результат после отправки
        fs.unlinkSync(imageData.source);
      }

      if (!isAdmin(userId)) deductBalance(userId, PRICE_RUB);
      appData.totalGenerations++;
      saveData();
    } else {
      throw new Error('No image in response');
    }

  } catch (error) {
    console.error(`[${userId}] Error:`, error);

    let errorMessage = error.message;
    if (error.response?.data?.error?.message) {
      errorMessage = error.response.data.error.message;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(`❌ Ошибка генерации: ${errorMessage}\n\nПопробуйте ещё раз.`, {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Попробовать снова', 'generate')],
        [Markup.button.callback('📸 Новое фото', 'start')]
      ])
    });
  } finally {
    state.processing = false;
    // Очищаем временные файлы если остались
    const tempPath = path.join(__dirname, `temp_${userId}.png`);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});

// ============ АДМИНКА ============
bot.command('admin', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  await ctx.reply('👑 *Админ-панель*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📊 Статистика', 'admin_stats')],
      [Markup.button.callback('👥 Пользователи', 'admin_users')],
      [Markup.button.callback('🏢 Компании', 'admin_companies')],
      [Markup.button.callback('➕ Добавить пользователя', 'admin_add_user')],
      [Markup.button.callback('➕ Создать компанию', 'admin_add_company')]
    ])
  });
});

bot.action('admin_stats', async ctx => {
  await ctx.answerCbQuery();
  const userCount = Object.keys(appData.users).length;
  const companyCount = Object.keys(appData.companies).length;

  await ctx.reply(
    `📊 *Статистика*\n\n` +
    `👥 Пользователей: ${userCount}\n` +
    `🏢 Компаний: ${companyCount}\n` +
    `🎨 Генераций: ${appData.totalGenerations}\n` +
    `💰 Выручка: ${appData.totalRevenue} ₽`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('admin_users', async ctx => {
  await ctx.answerCbQuery();
  const users = Object.entries(appData.users);

  if (users.length === 0) {
    return ctx.reply('Пользователей пока нет.');
  }

  let text = '👥 *Пользователи:*\n\n';
  for (const [id, user] of users) {
    const balance = getUserBalance(parseInt(id));
    text += `• ${user.name || id} - ${balance} ₽\n`;
  }

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.action('admin_companies', async ctx => {
  await ctx.answerCbQuery();
  const companies = Object.entries(appData.companies);

  if (companies.length === 0) {
    return ctx.reply('Компаний пока нет.');
  }

  let text = '🏢 *Компании:*\n\n';
  for (const [id, company] of companies) {
    text += `• ${company.name} - ${company.balance} ₽\n`;
  }

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.action('admin_add_user', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  state.adminMode = 'add_user';

  await ctx.reply('👤 Отправьте данные нового пользователя в формате:\n\n`ID имя`\n\nПример: `123456789 Иван`', { parse_mode: 'Markdown' });
});

bot.action('admin_add_company', async ctx => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  state.adminMode = 'add_company';

  await ctx.reply('🏢 Отправьте название новой компании:', { parse_mode: 'Markdown' });
});

// Обработка текста для админки
bot.on('text', async ctx => {
  if (!isAdmin(ctx.from.id)) return;

  const state = getState(ctx.from.id);
  const text = ctx.message.text;

  if (state.adminMode === 'add_user') {
    const match = text.match(/^(\d+)\s+(.+)$/);
    if (!match) {
      return ctx.reply('Неверный формат. Используйте: `ID имя`', { parse_mode: 'Markdown' });
    }

    const [, id, name] = match;
    appData.users[id] = { name, companyId: null };
    appData.individuals[id] = { balance: 0 };
    saveData();

    state.adminMode = null;
    await ctx.reply(`✅ Пользователь ${name} (${id}) добавлен!`);
  } else if (state.adminMode === 'add_company') {
    const companyId = Date.now().toString();
    appData.companies[companyId] = { name: text, balance: 0 };
    saveData();

    state.adminMode = null;
    await ctx.reply(`✅ Компания "${text}" создана!\n\nID: ${companyId}`);
  }
});

// ============ ЗАПУСК ============
bot.launch();
console.log('🚀 Бот запущен! (OpenAI gpt-image-1)');
console.log(`   Админы: ${ADMIN_IDS.join(', ')}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
