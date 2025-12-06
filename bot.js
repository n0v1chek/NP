require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const Replicate = require('replicate');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const ADMIN_IDS = process.env.ADMIN_IDS?.split(',').map(id => parseInt(id.trim())) || [];
const PRICE_RUB = 50;
const DATA_FILE = path.join(__dirname, 'data.json');

// ============ СЛОВАРЬ ЭЛЕМЕНТОВ ДЛЯ ПРОМПТА ============
const CEILING_DICTIONARY = `
=== IMPORTANT RULES ===
FORBIDDEN: Any black areas, dark patches, dark zones, or shadows ON the ceiling surface! The ceiling surface must be uniformly colored (white/beige/gray). Only the thin junction LINE between ceiling and wall can be dark.

=== CEILING PROFILES (how ceiling meets wall) ===

PERIMETER GAP PROFILE:
- A thin 10-15mm dark LINE/GROOVE visible ONLY at the junction where ceiling meets wall
- This is just a thin decorative LINE at the edge, like a picture frame border
- The ceiling surface itself stays completely white/clean
- Only the narrow strip RIGHT AT THE WALL EDGE appears as dark line

LED PERIMETER PROFILE:
- Soft ambient light glowing FROM the gap between ceiling and wall
- Light illuminates the upper part of the wall
- Creates impression ceiling is floating
- NO light strips visible on ceiling surface

STANDARD PROFILE:
- Ceiling meets wall directly with white trim
- Clean simple junction

=== CEILING TEXTURE ===

GLOSSY/MIRROR FINISH:
- Ceiling reflects the room like a mirror
- You see furniture, windows reflected on ceiling
- Shiny polished lacquer appearance

MATTE FINISH:
- No reflections, flat paint look

=== LIGHTING ===

RECESSED SPOTLIGHTS:
- Small round white circles (5-7cm) on ceiling
- Flush with surface, not protruding
- Must be clearly visible as round dots
===
`;

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

// ============ НОВАЯ СТРУКТУРА CONFIG ============
function getDefaultConfig() {
  return {
    // Полотно
    color: 'white',
    texture: 'matte',
    levels: 'single',

    // Профили для каждой стены отдельно
    profiles: {
      top: 'standard',
      right: 'standard',
      bottom: 'standard',
      left: 'standard'
    },

    // Споты
    spots: {
      enabled: false,
      count: 6,
      layout: 'grid',
      positions: []
    },

    // Люстра
    chandelier: {
      enabled: false,
      style: 'modern',
      position: 'center'
    },

    // Световые линии
    lightLines: {
      enabled: false,
      count: 1,
      direction: 'along',
      length: 'full'
    },

    // Карниз
    cornice: {
      enabled: false,
      type: 'hidden'
    }
  };
}

function getState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      photo: null,
      photoWithGrid: null,
      step: 'idle',
      processing: false,
      config: getDefaultConfig(),
      adminMode: null,
      tempData: {}
    });
  }
  return userStates.get(userId);
}

// ============ СЕТКА 20x20 ============
async function createGridOverlay(imageBuffer) {
  const img = sharp(imageBuffer);
  const meta = await img.metadata();
  const w = meta.width, h = meta.height;

  const cols = 20;
  const rows = 20;
  const cellW = w / cols;
  const cellH = h / rows;

  // Буквы A-T для строк
  const rowLabels = 'ABCDEFGHIJKLMNOPQRST'.split('');

  let svgElements = [];

  // Вертикальные линии
  for (let i = 0; i <= cols; i++) {
    const x = Math.floor(i * cellW);
    svgElements.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="rgba(255,255,0,0.5)" stroke-width="1"/>`);
  }

  // Горизонтальные линии
  for (let i = 0; i <= rows; i++) {
    const y = Math.floor(i * cellH);
    svgElements.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="rgba(255,255,0,0.5)" stroke-width="1"/>`);
  }

  // Подписи колонок (1-20) сверху
  for (let i = 0; i < cols; i++) {
    const x = Math.floor(i * cellW + cellW / 2);
    svgElements.push(`<text x="${x}" y="15" font-size="12" fill="yellow" text-anchor="middle" font-family="Arial" font-weight="bold">${i + 1}</text>`);
  }

  // Подписи строк (A-T) слева
  for (let i = 0; i < rows; i++) {
    const y = Math.floor(i * cellH + cellH / 2 + 4);
    svgElements.push(`<text x="8" y="${y}" font-size="12" fill="yellow" text-anchor="middle" font-family="Arial" font-weight="bold">${rowLabels[i]}</text>`);
  }

  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    ${svgElements.join('\n')}
  </svg>`;

  const gridBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

  // Накладываем сетку на фото
  return sharp(imageBuffer)
    .composite([{ input: gridBuffer, blend: 'over' }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

// ============ ОПЦИИ ============
const COLORS = {
  white: { label: '⬜ Белый', en: 'pure white' },
  beige: { label: '🟨 Бежевый', en: 'warm beige cream' },
  gray: { label: '⬛ Серый', en: 'light gray' },
  black: { label: '🖤 Чёрный', en: 'deep black' }
};

const TEXTURES = {
  matte: { label: '🎨 Матовый', en: 'MATTE FLAT surface with absolutely ZERO reflections, like painted drywall, no shine no gloss' },
  glossy: { label: '✨ Глянцевый', en: 'HIGH-GLOSS MIRROR-LIKE REFLECTIVE LACQUERED surface - the ceiling REFLECTS the room like a mirror, you can see clear REFLECTIONS of furniture, windows, floor on the ceiling surface, wet polished look' },
  satin: { label: '🌟 Сатиновый', en: 'SATIN pearl-finish with soft silky sheen, subtle shimmer but not mirror-like' }
};

const LEVELS = {
  single: { label: '1️⃣ Одноуровневый', en: 'single level flat smooth ceiling' },
  twolevel: { label: '2️⃣ Двухуровневый', en: 'two-level ceiling with lower gypsum board border frame around perimeter' }
};

const PROFILES = {
  standard: { label: '➖ Обычный', en: 'standard junction with white trim' },
  shadow: { label: '🔲 Теневой', en: 'PERIMETER GAP - thin 10mm dark LINE at ceiling-wall junction only, ceiling surface stays white' },
  floating: { label: '💫 Парящий', en: 'LED PERIMETER - soft glow from gap between ceiling edge and wall, light on wall' }
};

const SPOT_COUNTS = ['4', '6', '8', '10', '12'];

const SPOT_LAYOUTS = {
  grid: { label: '⊞ Сеткой', en: 'arranged in symmetrical grid pattern' },
  perimeter: { label: '⬚ По периметру', en: 'arranged around perimeter edges' },
  center: { label: '⊙ В центре', en: 'clustered together in center area' },
  custom: { label: '📍 Вручную', en: 'at specific positions' }
};

const CHANDELIER_STYLES = {
  modern: { label: '🔘 Современная', en: 'modern minimalist geometric pendant light' },
  classic: { label: '🏛 Классическая', en: 'classic elegant chandelier with lampshades' },
  crystal: { label: '💎 Хрустальная', en: 'luxury crystal glass chandelier with sparkling drops' }
};

const LIGHT_LINE_DIRECTIONS = {
  along: { label: '↔ Вдоль', en: 'running lengthwise along the room' },
  across: { label: '↕ Поперёк', en: 'running across the room width' },
  diagonal: { label: '⤢ По диагонали', en: 'running diagonally' }
};

const WALL_NAMES = {
  top: '⬆️ Верх',
  right: '➡️ Право',
  bottom: '⬇️ Низ',
  left: '⬅️ Лево'
};


// ============ ПРОМПТЫ ДЛЯ ДВУХЭТАПНОЙ ГЕНЕРАЦИИ ============

// Этап 1: Чистый белый потолок без элементов
function buildStage1Prompt() {
  return `Replace the ceiling in this photo with a clean, smooth, flat white ceiling.
Remove all existing ceiling elements: tiles, panels, grid, lights, fixtures.
Result: perfectly smooth white matte ceiling surface with no elements.
Keep all walls, furniture, floor exactly as they are.
Photorealistic result.`;
}

// Этап 2: Добавление элементов на чистый потолок
function buildStage2Prompt(config) {
  const color = COLORS[config.color]?.en || 'pure white';
  let prompt = `Modify ONLY the ceiling in this photo.\n\n`;

  // Цвет и текстура
  prompt += `Ceiling: ${color} `;

  if (config.texture === 'glossy') {
    prompt += "HIGH-GLOSS MIRROR-LIKE surface that reflects the room like a polished mirror, shiny lacquer finish. ";
  } else if (config.texture === 'satin') {
    prompt += "satin pearl finish with soft subtle sheen. ";
  } else {
    prompt += "matte flat surface with no reflections. ";
  }

  // Профили по стенам
  const walls = ['top', 'right', 'bottom', 'left'];
  const wallNames = { top: 'far/top', right: 'right', bottom: 'near/bottom', left: 'left' };

  for (const wall of walls) {
    const profile = config.profiles[wall];
    if (profile === 'shadow') {
      prompt += `At ${wallNames[wall]} wall: thin 10mm dark gap/groove between ceiling edge and wall. `;
    } else if (profile === 'floating') {
      prompt += `At ${wallNames[wall]} wall: soft LED glow from gap between ceiling and wall, floating effect. `;
    }
  }

  // Споты
  if (config.spots.enabled) {
    const count = config.spots.count || 6;
    prompt += `\n\nAdd ${count} small round recessed LED spotlights (5-7cm white circles flush with ceiling). `;
    if (config.spots.layout === 'grid') {
      prompt += "Arranged in even grid pattern. ";
    } else if (config.spots.layout === 'perimeter') {
      prompt += "Arranged around ceiling perimeter. ";
    } else if (config.spots.layout === 'center') {
      prompt += "Clustered in center area. ";
    } else if (config.spots.positions.length > 0) {
      prompt += `At positions: ${config.spots.positions.join(', ')}. `;
    }
  }

  // Люстра
  if (config.chandelier.enabled) {
    const style = CHANDELIER_STYLES[config.chandelier.style]?.en || 'modern pendant light';
    const pos = config.chandelier.position === 'center' ? 'ceiling center' : `position ${config.chandelier.position}`;
    prompt += `\n\nAdd ${style} at ${pos}. `;
  }

  // Световые линии
  if (config.lightLines.enabled) {
    const count = config.lightLines.count || 1;
    const dir = LIGHT_LINE_DIRECTIONS[config.lightLines.direction]?.en || 'lengthwise';
    prompt += `\n\nAdd ${count} built-in LED light strip(s) ${dir}. `;
  }

  // Карниз
  if (config.cornice.enabled) {
    prompt += "\n\nAdd hidden curtain niche at window wall. ";
  }

  prompt += "\n\nKeep walls, floor, furniture unchanged. Photorealistic result.";

  return prompt;
}

// ============ ОДНОЭТАПНЫЙ ПРОМПТ ============
function buildCombinedPrompt(config) {
  const color = COLORS[config.color]?.en || 'pure white';

  let prompt = `Replace the ceiling in this interior photo with a modern stretch ceiling.\n\n`;
  prompt += `Remove all existing ceiling elements (tiles, panels, grid, old lights).\n\n`;

  // Цвет и текстура - УСИЛЕННЫЕ ФОРМУЛИРОВКИ
  prompt += `New ceiling: ${color} `;
  if (config.texture === 'glossy') {
    prompt += "GLOSSY WET-LOOK REFLECTIVE LACQUERED ceiling surface. The ceiling MUST show mirror reflections of the room - you should see the furniture, windows, and floor reflected on the glossy ceiling surface like a mirror. Shiny polished lacquer finish. ";
  } else if (config.texture === 'satin') {
    prompt += "satin pearl finish with soft subtle sheen. ";
  } else {
    prompt += "smooth matte flat surface with no reflections. ";
  }

  // Профили по стенам - УСИЛЕННЫЕ ФОРМУЛИРОВКИ
  const walls = ['top', 'right', 'bottom', 'left'];
  const wallNames = { top: 'far/back', right: 'right', bottom: 'front/near', left: 'left' };

  for (const wall of walls) {
    const profile = config.profiles[wall];
    if (profile === 'shadow') {
      prompt += `\nIMPORTANT: At ${wallNames[wall]} wall add visible DARK SHADOW GAP - a thin 10-15mm BLACK LINE/GROOVE between ceiling edge and wall. This dark line MUST be clearly visible. `;
    } else if (profile === 'floating') {
      prompt += `\nIMPORTANT: At ${wallNames[wall]} wall add FLOATING CEILING EFFECT - visible LED strip glow shining from the gap between ceiling and wall, illuminating the wall. The ceiling appears to float. `;
    }
  }

  // СПОТЫ - КРИТИЧЕСКИ ВАЖНО, УСИЛЕННЫЕ ФОРМУЛИРОВКИ
  if (config.spots.enabled) {
    const count = config.spots.count || 6;
    prompt += `\n\nCRITICAL REQUIREMENT - SPOTLIGHTS: You MUST add exactly ${count} recessed ceiling spotlights (downlights). Each spotlight is a small round white circle (diameter 5-8cm) embedded flush into the ceiling surface. These spotlights MUST be clearly visible on the ceiling. `;
    if (config.spots.layout === 'grid') {
      prompt += `Arrange all ${count} spotlights in an evenly spaced symmetrical grid pattern across the ceiling. `;
    } else if (config.spots.layout === 'perimeter') {
      prompt += `Arrange all ${count} spotlights around the ceiling perimeter/edges. `;
    } else if (config.spots.layout === 'center') {
      prompt += `Arrange all ${count} spotlights clustered in the center area of the ceiling. `;
    }
    prompt += `DO NOT skip the spotlights - they are required! `;
  }

  // Люстра
  if (config.chandelier.enabled) {
    const style = CHANDELIER_STYLES[config.chandelier.style]?.en || 'modern pendant light';
    prompt += `\n\nAdd ${style} hanging from ceiling center. `;
  }

  // Световые линии
  if (config.lightLines.enabled) {
    const dir = LIGHT_LINE_DIRECTIONS[config.lightLines.direction]?.en || 'lengthwise';
    prompt += `\n\nAdd ${config.lightLines.count} glowing LED light line(s) built into ceiling ${dir}. `;
  }

  // Карниз
  if (config.cornice.enabled) {
    prompt += `\n\nAdd hidden curtain niche/recess at the window wall where curtains emerge from ceiling. `;
  }

  prompt += "\n\nKeep all walls, floor, furniture exactly unchanged. Photorealistic interior photo result.";

  return prompt;
}

// Старый промпт (для резерва)
function buildPrompt(config) {
  // Начинаем с правил и запретов
  let prompt = CEILING_DICTIONARY;

  prompt += "\n\n=== TASK ===\n";
  prompt += "Edit this interior photo: remove old ceiling, add new modern stretch ceiling.\n\n";

  // Цвет - явно указываем что потолок должен быть однородным
  const color = COLORS[config.color]?.en || 'pure white';
  prompt += `CEILING: ${color} uniform color across entire ceiling surface. `;

  // Текстура
  if (config.texture === 'glossy') {
    prompt += "GLOSSY MIRROR finish - ceiling reflects the room like mirror, shiny lacquer look. ";
  } else if (config.texture === 'satin') {
    prompt += "SATIN finish with soft sheen. ";
  } else {
    prompt += "MATTE flat finish, no reflections. ";
  }

  prompt += LEVELS[config.levels]?.en + ". ";

  // Профили - переформулировано без слова shadow
  const walls = ['top', 'right', 'bottom', 'left'];
  const wallNames = { top: 'far/top', right: 'right', bottom: 'near/bottom', left: 'left' };

  let hasGapProfile = false;
  let hasLedProfile = false;

  for (const wall of walls) {
    if (config.profiles[wall] === 'shadow') hasGapProfile = true;
    if (config.profiles[wall] === 'floating') hasLedProfile = true;
  }

  // Описываем профили
  if (hasGapProfile || hasLedProfile) {
    prompt += "\n\nCEILING EDGE DETAILS: ";

    for (const wall of walls) {
      const profile = config.profiles[wall];
      if (profile === 'shadow') {
        prompt += `At ${wallNames[wall]} wall: thin dark LINE (10mm) at ceiling-wall junction. `;
      } else if (profile === 'floating') {
        prompt += `At ${wallNames[wall]} wall: ambient glow between ceiling and wall, ceiling appears floating. `;
      }
    }
  }

  // Споты
  if (config.spots.enabled) {
    const count = config.spots.count || 6;
    const layout = SPOT_LAYOUTS[config.spots.layout]?.en || 'evenly spaced';
    prompt += `\n\nLIGHTING: ${count} small round recessed spotlights (white circles 5-7cm) ${layout} on ceiling. `;

    if (config.spots.layout === 'custom' && config.spots.positions.length > 0) {
      prompt += `At positions: ${config.spots.positions.join(', ')}. `;
    }
  }

  // Люстра
  if (config.chandelier.enabled) {
    const style = CHANDELIER_STYLES[config.chandelier.style]?.en || 'modern pendant';
    const pos = config.chandelier.position === 'center' ? 'center' : config.chandelier.position;
    prompt += `\n\nCHANDELIER: ${style} at ${pos}. `;
  }

  // Световые линии
  if (config.lightLines.enabled) {
    const count = config.lightLines.count || 1;
    const dir = LIGHT_LINE_DIRECTIONS[config.lightLines.direction]?.en || 'lengthwise';
    prompt += `\n\nLIGHT LINES: ${count} LED strip(s) built into ceiling ${dir}. `;
  }

  // Карниз
  if (config.cornice.enabled) {
    prompt += "\n\nHidden curtain niche at window. ";
  }

  // КРИТИЧЕСКИЕ ЗАПРЕТЫ
  prompt += "\n\n=== CRITICAL ===\n";
  prompt += "- NO black areas or dark patches on ceiling surface\n";
  prompt += "- Ceiling must be uniformly " + color + "\n";
  prompt += "- Keep all walls, floor, furniture unchanged\n";
  prompt += "- Photorealistic result";

  return prompt;
}

// ============ СВОДКА КОНФИГА ============
function buildSummary(config) {
  const lines = [];
  lines.push(`🎨 Цвет: ${COLORS[config.color]?.label}`);
  lines.push(`✨ Текстура: ${TEXTURES[config.texture]?.label}`);
  lines.push(`🏗 Уровни: ${LEVELS[config.levels]?.label}`);

  // Профили
  const profileSummary = [];
  for (const [wall, profile] of Object.entries(config.profiles)) {
    if (profile !== 'standard') {
      profileSummary.push(`${WALL_NAMES[wall]}: ${PROFILES[profile]?.label}`);
    }
  }
  if (profileSummary.length > 0) {
    lines.push(`📐 Профили: ${profileSummary.join(', ')}`);
  } else {
    lines.push(`📐 Профили: все стандартные`);
  }

  if (config.spots.enabled) {
    let spotsInfo = `${config.spots.count} шт (${SPOT_LAYOUTS[config.spots.layout]?.label})`;
    if (config.spots.layout === 'custom' && config.spots.positions.length > 0) {
      spotsInfo += `: ${config.spots.positions.join(', ')}`;
    }
    lines.push(`💡 Споты: ${spotsInfo}`);
  }

  if (config.chandelier.enabled) {
    const pos = config.chandelier.position === 'center' ? 'центр' : config.chandelier.position;
    lines.push(`🪔 Люстра: ${CHANDELIER_STYLES[config.chandelier.style]?.label} (${pos})`);
  }

  if (config.lightLines.enabled) {
    lines.push(`📏 Линии: ${config.lightLines.count} шт (${LIGHT_LINE_DIRECTIONS[config.lightLines.direction]?.label})`);
  }

  if (config.cornice.enabled) {
    lines.push(`🪟 Карниз: скрытый`);
  }

  return lines.join('\n');
}

// ============ КЛАВИАТУРЫ ============
function mainMenu(isAdm) {
  const btns = [[Markup.button.callback('📸 Создать визуализацию', 'start')]];
  btns.push([Markup.button.callback('💰 Баланс', 'balance')]);
  if (isAdm) btns.push([Markup.button.callback('👑 Админ', 'admin')]);
  return Markup.inlineKeyboard(btns);
}

function configMenu(config) {
  const spotsIcon = config.spots.enabled ? '✅' : '❌';
  const chandelierIcon = config.chandelier.enabled ? '✅' : '❌';
  const linesIcon = config.lightLines.enabled ? '✅' : '❌';
  const corniceIcon = config.cornice.enabled ? '✅' : '❌';

  // Показываем какие профили нестандартные
  const nonStdProfiles = Object.entries(config.profiles).filter(([,v]) => v !== 'standard').length;
  const profileLabel = nonStdProfiles > 0 ? `📐 Профили (${nonStdProfiles} изм.)` : '📐 Профили стен';

  return Markup.inlineKeyboard([
    [Markup.button.callback(`🎨 ${COLORS[config.color]?.label}`, 'cfg_color'),
     Markup.button.callback(`${TEXTURES[config.texture]?.label}`, 'cfg_texture')],
    [Markup.button.callback(`🏗 ${LEVELS[config.levels]?.label}`, 'cfg_levels')],
    [Markup.button.callback(profileLabel, 'cfg_profiles')],
    [Markup.button.callback(`💡 Споты: ${spotsIcon}`, 'cfg_spots'),
     Markup.button.callback(`🪔 Люстра: ${chandelierIcon}`, 'cfg_chandelier')],
    [Markup.button.callback(`📏 Линии: ${linesIcon}`, 'cfg_lines'),
     Markup.button.callback(`🪟 Карниз: ${corniceIcon}`, 'cfg_cornice')],
    [Markup.button.callback('🖼 Показать сетку', 'show_grid')],
    [Markup.button.callback('✅ Готово - создать', 'generate')],
    [Markup.button.callback('❌ Отмена', 'cancel')]
  ]);
}

function colorMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(COLORS.white.label, 'set_color_white'),
     Markup.button.callback(COLORS.beige.label, 'set_color_beige')],
    [Markup.button.callback(COLORS.gray.label, 'set_color_gray'),
     Markup.button.callback(COLORS.black.label, 'set_color_black')],
    [Markup.button.callback('⬅️ Назад', 'back_config')]
  ]);
}

function textureMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(TEXTURES.matte.label, 'set_texture_matte')],
    [Markup.button.callback(TEXTURES.glossy.label, 'set_texture_glossy')],
    [Markup.button.callback(TEXTURES.satin.label, 'set_texture_satin')],
    [Markup.button.callback('⬅️ Назад', 'back_config')]
  ]);
}

function levelsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(LEVELS.single.label, 'set_levels_single')],
    [Markup.button.callback(LEVELS.twolevel.label, 'set_levels_twolevel')],
    [Markup.button.callback('⬅️ Назад', 'back_config')]
  ]);
}

// Меню выбора стены для настройки профиля
function profilesMenu(config) {
  const btns = [];
  for (const [wall, name] of Object.entries(WALL_NAMES)) {
    const profile = config.profiles[wall];
    const label = `${name}: ${PROFILES[profile]?.label}`;
    btns.push([Markup.button.callback(label, `cfg_profile_${wall}`)]);
  }
  btns.push([Markup.button.callback('🔄 Все одинаковые', 'cfg_profile_all')]);
  btns.push([Markup.button.callback('⬅️ Назад', 'back_config')]);
  return Markup.inlineKeyboard(btns);
}

// Меню выбора профиля для конкретной стены
function profileSelectMenu(wall) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(PROFILES.standard.label, `set_profile_${wall}_standard`)],
    [Markup.button.callback(PROFILES.shadow.label + ' (тёмная щель)', `set_profile_${wall}_shadow`)],
    [Markup.button.callback(PROFILES.floating.label + ' (LED подсветка)', `set_profile_${wall}_floating`)],
    [Markup.button.callback('⬅️ Назад', 'cfg_profiles')]
  ]);
}

// Меню для установки всех профилей одинаковыми
function profileAllMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Все ' + PROFILES.standard.label, 'set_profile_all_standard')],
    [Markup.button.callback('Все ' + PROFILES.shadow.label, 'set_profile_all_shadow')],
    [Markup.button.callback('Все ' + PROFILES.floating.label, 'set_profile_all_floating')],
    [Markup.button.callback('⬅️ Назад', 'cfg_profiles')]
  ]);
}

function spotsMenu(config) {
  const enabled = config.spots.enabled;
  const btns = [
    [Markup.button.callback(enabled ? '🔴 Выключить' : '🟢 Включить', 'spots_toggle')]
  ];
  if (enabled) {
    btns.push([Markup.button.callback(`Кол-во: ${config.spots.count} шт`, 'spots_count')]);
    btns.push([Markup.button.callback(`Расположение: ${SPOT_LAYOUTS[config.spots.layout]?.label}`, 'spots_layout')]);
    if (config.spots.layout === 'custom') {
      const posStr = config.spots.positions.length > 0 ? config.spots.positions.join(', ') : 'не заданы';
      btns.push([Markup.button.callback(`📍 Позиции: ${posStr}`, 'spots_positions')]);
    }
  }
  btns.push([Markup.button.callback('⬅️ Назад', 'back_config')]);
  return Markup.inlineKeyboard(btns);
}

function spotsCountMenu() {
  const btns = [];
  for (let i = 0; i < SPOT_COUNTS.length; i += 2) {
    const row = [Markup.button.callback(`${SPOT_COUNTS[i]} шт`, `set_spots_count_${SPOT_COUNTS[i]}`)];
    if (SPOT_COUNTS[i + 1]) {
      row.push(Markup.button.callback(`${SPOT_COUNTS[i + 1]} шт`, `set_spots_count_${SPOT_COUNTS[i + 1]}`));
    }
    btns.push(row);
  }
  btns.push([Markup.button.callback('⬅️ Назад', 'cfg_spots')]);
  return Markup.inlineKeyboard(btns);
}

function spotsLayoutMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(SPOT_LAYOUTS.grid.label, 'set_spots_layout_grid')],
    [Markup.button.callback(SPOT_LAYOUTS.perimeter.label, 'set_spots_layout_perimeter')],
    [Markup.button.callback(SPOT_LAYOUTS.center.label, 'set_spots_layout_center')],
    [Markup.button.callback(SPOT_LAYOUTS.custom.label + ' (координаты)', 'set_spots_layout_custom')],
    [Markup.button.callback('⬅️ Назад', 'cfg_spots')]
  ]);
}

function chandelierMenu(config) {
  const enabled = config.chandelier.enabled;
  const btns = [
    [Markup.button.callback(enabled ? '🔴 Выключить' : '🟢 Включить', 'chandelier_toggle')]
  ];
  if (enabled) {
    btns.push([Markup.button.callback(`Стиль: ${CHANDELIER_STYLES[config.chandelier.style]?.label}`, 'chandelier_style')]);
    const posLabel = config.chandelier.position === 'center' ? 'центр' : config.chandelier.position;
    btns.push([Markup.button.callback(`Позиция: ${posLabel}`, 'chandelier_position')]);
  }
  btns.push([Markup.button.callback('⬅️ Назад', 'back_config')]);
  return Markup.inlineKeyboard(btns);
}

function chandelierStyleMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(CHANDELIER_STYLES.modern.label, 'set_chandelier_style_modern')],
    [Markup.button.callback(CHANDELIER_STYLES.classic.label, 'set_chandelier_style_classic')],
    [Markup.button.callback(CHANDELIER_STYLES.crystal.label, 'set_chandelier_style_crystal')],
    [Markup.button.callback('⬅️ Назад', 'cfg_chandelier')]
  ]);
}

function chandelierPositionMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⊙ Центр', 'set_chandelier_pos_center')],
    [Markup.button.callback('📍 Ввести координату', 'set_chandelier_pos_custom')],
    [Markup.button.callback('⬅️ Назад', 'cfg_chandelier')]
  ]);
}

function linesMenu(config) {
  const enabled = config.lightLines.enabled;
  const btns = [
    [Markup.button.callback(enabled ? '🔴 Выключить' : '🟢 Включить', 'lines_toggle')]
  ];
  if (enabled) {
    btns.push([Markup.button.callback(`Кол-во: ${config.lightLines.count}`, 'lines_count')]);
    btns.push([Markup.button.callback(`Направление: ${LIGHT_LINE_DIRECTIONS[config.lightLines.direction]?.label}`, 'lines_direction')]);
    btns.push([Markup.button.callback(`Длина: ${config.lightLines.length === 'full' ? 'на всю' : '70%'}`, 'lines_length')]);
  }
  btns.push([Markup.button.callback('⬅️ Назад', 'back_config')]);
  return Markup.inlineKeyboard(btns);
}

function linesCountMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('1 линия', 'set_lines_count_1')],
    [Markup.button.callback('2 линии', 'set_lines_count_2')],
    [Markup.button.callback('3 линии', 'set_lines_count_3')],
    [Markup.button.callback('⬅️ Назад', 'cfg_lines')]
  ]);
}

function linesDirectionMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(LIGHT_LINE_DIRECTIONS.along.label, 'set_lines_dir_along')],
    [Markup.button.callback(LIGHT_LINE_DIRECTIONS.across.label, 'set_lines_dir_across')],
    [Markup.button.callback(LIGHT_LINE_DIRECTIONS.diagonal.label, 'set_lines_dir_diagonal')],
    [Markup.button.callback('⬅️ Назад', 'cfg_lines')]
  ]);
}

function linesLengthMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📏 На всю длину', 'set_lines_len_full')],
    [Markup.button.callback('📐 70% длины', 'set_lines_len_partial')],
    [Markup.button.callback('⬅️ Назад', 'cfg_lines')]
  ]);
}

function corniceMenu(config) {
  const enabled = config.cornice.enabled;
  return Markup.inlineKeyboard([
    [Markup.button.callback(enabled ? '🔴 Выключить' : '🟢 Включить', 'cornice_toggle')],
    [Markup.button.callback('⬅️ Назад', 'back_config')]
  ]);
}

// ============ MIDDLEWARE ============
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (isAdmin(userId)) return next();
  if (!isAllowedUser(userId)) {
    if (ctx.message?.text === '/start' || ctx.callbackQuery) {
      return ctx.reply(`🔒 Доступ ограничен\n\nВаш ID: \`${userId}\``, { parse_mode: 'Markdown' });
    }
    return;
  }
  return next();
});

// ============ КОМАНДЫ ============
bot.command('start', ctx => {
  const state = getState(ctx.from.id);
  state.step = 'idle';
  state.photo = null;
  state.photoWithGrid = null;
  state.config = getDefaultConfig();
  ctx.reply('🏠 *Визуализация натяжных потолков*\n\nЗагрузите фото и настройте параметры.\nСетка 20×20 поможет точно указать позиции элементов.', { parse_mode: 'Markdown', ...mainMenu(isAdmin(ctx.from.id)) });
});

bot.action('start', async ctx => {
  const state = getState(ctx.from.id);
  state.step = 'photo';
  state.photo = null;
  state.photoWithGrid = null;
  state.config = getDefaultConfig();
  await ctx.answerCbQuery();
  await ctx.editMessageText('📸 *Отправьте фото помещения*\n\nФото должно чётко показывать потолок.', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel')]]) });
});

bot.action('balance', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`💰 *Баланс: ${getUserBalance(ctx.from.id)}₽*\n\nСтоимость генерации: ${PRICE_RUB}₽`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'menu')]]) });
});

bot.action('menu', async ctx => {
  getState(ctx.from.id).step = 'idle';
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText('🏠 *Визуализация натяжных потолков*', { parse_mode: 'Markdown', ...mainMenu(isAdmin(ctx.from.id)) });
  } catch (e) {
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply('🏠 *Визуализация натяжных потолков*', { parse_mode: 'Markdown', ...mainMenu(isAdmin(ctx.from.id)) });
  }
});

bot.action('cancel', async ctx => {
  const state = getState(ctx.from.id);
  state.step = 'idle';
  state.photo = null;
  state.photoWithGrid = null;
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText('❌ Отменено', Markup.inlineKeyboard([[Markup.button.callback('🔙 Меню', 'menu')]]));
  } catch {
    await ctx.reply('❌ Отменено', Markup.inlineKeyboard([[Markup.button.callback('🔙 Меню', 'menu')]]));
  }
});

// ============ ВОЗВРАТ В КОНФИГ ============
bot.action('back_config', async ctx => {
  const state = getState(ctx.from.id);
  state.step = 'config';
  await ctx.answerCbQuery();
  const summary = buildSummary(state.config);
  const text = `⚙️ *Настройка потолка*\n\n${summary}\n\n💰 Стоимость: ${PRICE_RUB}₽`;
  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...configMenu(state.config) });
  } catch (e) {
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(text, { parse_mode: 'Markdown', ...configMenu(state.config) });
  }
});

// ============ ПОКАЗАТЬ СЕТКУ ============
bot.action('show_grid', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();

  if (!state.photoWithGrid && state.photo) {
    state.photoWithGrid = await createGridOverlay(state.photo);
  }

  if (state.photoWithGrid) {
    await ctx.replyWithPhoto({ source: state.photoWithGrid }, {
      caption: '🔢 *Сетка координат*\n\nСтроки: A-T (сверху вниз)\nСтолбцы: 1-20 (слева направо)\n\nПример координаты: K10, F5',
      parse_mode: 'Markdown'
    });
  }
});

// ============ ЦВЕТ ============
bot.action('cfg_color', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🎨 *Выберите цвет полотна:*', { parse_mode: 'Markdown', ...colorMenu() });
});

bot.action(/^set_color_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.color = ctx.match[1];
  await ctx.answerCbQuery(`Цвет: ${COLORS[ctx.match[1]]?.label}`);
  const summary = buildSummary(state.config);
  await ctx.editMessageText(`⚙️ *Настройка потолка*\n\n${summary}\n\n💰 Стоимость: ${PRICE_RUB}₽`, { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ТЕКСТУРА ============
bot.action('cfg_texture', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('✨ *Текстура полотна:*\n\n• Матовый - без отражений\n• Глянцевый - зеркальный, отражает комнату\n• Сатиновый - мягкий перламутровый блеск', { parse_mode: 'Markdown', ...textureMenu() });
});

bot.action(/^set_texture_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.texture = ctx.match[1];
  await ctx.answerCbQuery(`Текстура: ${TEXTURES[ctx.match[1]]?.label}`);
  const summary = buildSummary(state.config);
  await ctx.editMessageText(`⚙️ *Настройка потолка*\n\n${summary}\n\n💰 Стоимость: ${PRICE_RUB}₽`, { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ УРОВНИ ============
bot.action('cfg_levels', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🏗 *Конструкция:*\n\n• Одноуровневый - плоский потолок\n• Двухуровневый - с коробом по периметру', { parse_mode: 'Markdown', ...levelsMenu() });
});

bot.action(/^set_levels_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.levels = ctx.match[1];
  await ctx.answerCbQuery(`Уровни: ${LEVELS[ctx.match[1]]?.label}`);
  const summary = buildSummary(state.config);
  await ctx.editMessageText(`⚙️ *Настройка потолка*\n\n${summary}\n\n💰 Стоимость: ${PRICE_RUB}₽`, { parse_mode: 'Markdown', ...configMenu(state.config) });
});

// ============ ПРОФИЛИ СТЕН ============
bot.action('cfg_profiles', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText('📐 *Профили по стенам*\n\nВыберите стену для настройки профиля крепления:\n\n• Обычный - стык с плинтусом\n• Теневой - тёмная щель 10мм\n• Парящий - LED подсветка', { parse_mode: 'Markdown', ...profilesMenu(state.config) });
});

bot.action(/^cfg_profile_(.+)$/, async ctx => {
  const wall = ctx.match[1];
  await ctx.answerCbQuery();

  if (wall === 'all') {
    await ctx.editMessageText('📐 *Установить все профили одинаковыми:*', { parse_mode: 'Markdown', ...profileAllMenu() });
  } else {
    const wallName = WALL_NAMES[wall];
    await ctx.editMessageText(`📐 *Профиль для стены ${wallName}:*`, { parse_mode: 'Markdown', ...profileSelectMenu(wall) });
  }
});

bot.action(/^set_profile_all_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  const profile = ctx.match[1];
  state.config.profiles = { top: profile, right: profile, bottom: profile, left: profile };
  await ctx.answerCbQuery(`Все профили: ${PROFILES[profile]?.label}`);
  await ctx.editMessageText('📐 *Профили по стенам*\n\nВыберите стену для настройки:', { parse_mode: 'Markdown', ...profilesMenu(state.config) });
});

bot.action(/^set_profile_(\w+)_(\w+)$/, async ctx => {
  const state = getState(ctx.from.id);
  const wall = ctx.match[1];
  const profile = ctx.match[2];

  if (wall !== 'all') {
    state.config.profiles[wall] = profile;
    await ctx.answerCbQuery(`${WALL_NAMES[wall]}: ${PROFILES[profile]?.label}`);
    await ctx.editMessageText('📐 *Профили по стенам*\n\nВыберите стену для настройки:', { parse_mode: 'Markdown', ...profilesMenu(state.config) });
  }
});

// ============ СПОТЫ ============
bot.action('cfg_spots', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText('💡 *Точечные светильники (споты)*\n\nМаленькие круглые LED-светильники, встроенные вровень с потолком.', { parse_mode: 'Markdown', ...spotsMenu(state.config) });
});

bot.action('spots_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.enabled = !state.config.spots.enabled;
  await ctx.answerCbQuery(state.config.spots.enabled ? 'Споты вкл' : 'Споты выкл');
  await ctx.editMessageText('💡 *Точечные светильники*', { parse_mode: 'Markdown', ...spotsMenu(state.config) });
});

bot.action('spots_count', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('💡 *Количество спотов:*', { parse_mode: 'Markdown', ...spotsCountMenu() });
});

bot.action(/^set_spots_count_(\d+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.count = parseInt(ctx.match[1]);
  await ctx.answerCbQuery(`${ctx.match[1]} спотов`);
  await ctx.editMessageText('💡 *Точечные светильники*', { parse_mode: 'Markdown', ...spotsMenu(state.config) });
});

bot.action('spots_layout', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('💡 *Расположение спотов:*', { parse_mode: 'Markdown', ...spotsLayoutMenu() });
});

bot.action(/^set_spots_layout_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.layout = ctx.match[1];
  await ctx.answerCbQuery(`Расположение: ${SPOT_LAYOUTS[ctx.match[1]]?.label}`);

  if (ctx.match[1] === 'custom') {
    state.step = 'spots_positions';
    await ctx.editMessageText('💡 *Введите координаты спотов*\n\nФормат: K5, L10, M15\n(буква строки + номер столбца)\n\nНажмите "Показать сетку" чтобы увидеть координаты.', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🖼 Показать сетку', 'show_grid')],
        [Markup.button.callback('⬅️ Назад', 'cfg_spots')]
      ])
    });
  } else {
    await ctx.editMessageText('💡 *Точечные светильники*', { parse_mode: 'Markdown', ...spotsMenu(state.config) });
  }
});

bot.action('spots_positions', async ctx => {
  const state = getState(ctx.from.id);
  state.step = 'spots_positions';
  await ctx.answerCbQuery();
  await ctx.editMessageText('💡 *Введите координаты спотов*\n\nФормат: K5, L10, M15\n\nТекущие: ' + (state.config.spots.positions.join(', ') || 'не заданы'), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🖼 Показать сетку', 'show_grid')],
      [Markup.button.callback('🗑 Очистить', 'clear_spots_positions')],
      [Markup.button.callback('⬅️ Назад', 'cfg_spots')]
    ])
  });
});

bot.action('clear_spots_positions', async ctx => {
  const state = getState(ctx.from.id);
  state.config.spots.positions = [];
  await ctx.answerCbQuery('Позиции очищены');
  await ctx.editMessageText('💡 *Точечные светильники*', { parse_mode: 'Markdown', ...spotsMenu(state.config) });
});

// ============ ЛЮСТРА ============
bot.action('cfg_chandelier', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText('🪔 *Люстра*\n\nПодвесной светильник в центре или в указанной точке.', { parse_mode: 'Markdown', ...chandelierMenu(state.config) });
});

bot.action('chandelier_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.chandelier.enabled = !state.config.chandelier.enabled;
  await ctx.answerCbQuery(state.config.chandelier.enabled ? 'Люстра вкл' : 'Люстра выкл');
  await ctx.editMessageText('🪔 *Люстра*', { parse_mode: 'Markdown', ...chandelierMenu(state.config) });
});

bot.action('chandelier_style', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🪔 *Стиль люстры:*', { parse_mode: 'Markdown', ...chandelierStyleMenu() });
});

bot.action(/^set_chandelier_style_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.chandelier.style = ctx.match[1];
  await ctx.answerCbQuery(`Стиль: ${CHANDELIER_STYLES[ctx.match[1]]?.label}`);
  await ctx.editMessageText('🪔 *Люстра*', { parse_mode: 'Markdown', ...chandelierMenu(state.config) });
});

bot.action('chandelier_position', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🪔 *Позиция люстры:*', { parse_mode: 'Markdown', ...chandelierPositionMenu() });
});

bot.action('set_chandelier_pos_center', async ctx => {
  const state = getState(ctx.from.id);
  state.config.chandelier.position = 'center';
  await ctx.answerCbQuery('Позиция: центр');
  await ctx.editMessageText('🪔 *Люстра*', { parse_mode: 'Markdown', ...chandelierMenu(state.config) });
});

bot.action('set_chandelier_pos_custom', async ctx => {
  const state = getState(ctx.from.id);
  state.step = 'chandelier_position';
  await ctx.answerCbQuery();
  await ctx.editMessageText('🪔 *Введите координату люстры*\n\nФормат: J10 (буква + число)', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🖼 Показать сетку', 'show_grid')],
      [Markup.button.callback('⬅️ Назад', 'cfg_chandelier')]
    ])
  });
});

// ============ СВЕТОВЫЕ ЛИНИИ ============
bot.action('cfg_lines', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText('📏 *Световые линии*\n\nLED-профили встроенные в потолок, светятся полосой.', { parse_mode: 'Markdown', ...linesMenu(state.config) });
});

bot.action('lines_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightLines.enabled = !state.config.lightLines.enabled;
  await ctx.answerCbQuery(state.config.lightLines.enabled ? 'Линии вкл' : 'Линии выкл');
  await ctx.editMessageText('📏 *Световые линии*', { parse_mode: 'Markdown', ...linesMenu(state.config) });
});

bot.action('lines_count', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📏 *Количество линий:*', { parse_mode: 'Markdown', ...linesCountMenu() });
});

bot.action(/^set_lines_count_(\d+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightLines.count = parseInt(ctx.match[1]);
  await ctx.answerCbQuery(`${ctx.match[1]} линий`);
  await ctx.editMessageText('📏 *Световые линии*', { parse_mode: 'Markdown', ...linesMenu(state.config) });
});

bot.action('lines_direction', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📏 *Направление линий:*', { parse_mode: 'Markdown', ...linesDirectionMenu() });
});

bot.action(/^set_lines_dir_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightLines.direction = ctx.match[1];
  await ctx.answerCbQuery(`Направление: ${LIGHT_LINE_DIRECTIONS[ctx.match[1]]?.label}`);
  await ctx.editMessageText('📏 *Световые линии*', { parse_mode: 'Markdown', ...linesMenu(state.config) });
});

bot.action('lines_length', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📏 *Длина линий:*', { parse_mode: 'Markdown', ...linesLengthMenu() });
});

bot.action(/^set_lines_len_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.config.lightLines.length = ctx.match[1];
  await ctx.answerCbQuery(ctx.match[1] === 'full' ? 'На всю длину' : '70% длины');
  await ctx.editMessageText('📏 *Световые линии*', { parse_mode: 'Markdown', ...linesMenu(state.config) });
});

// ============ КАРНИЗ ============
bot.action('cfg_cornice', async ctx => {
  const state = getState(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText('🪟 *Скрытый карниз*\n\nНиша у окна для штор - шторы "выходят" из потолка.', { parse_mode: 'Markdown', ...corniceMenu(state.config) });
});

bot.action('cornice_toggle', async ctx => {
  const state = getState(ctx.from.id);
  state.config.cornice.enabled = !state.config.cornice.enabled;
  await ctx.answerCbQuery(state.config.cornice.enabled ? 'Карниз вкл' : 'Карниз выкл');
  await ctx.editMessageText('🪟 *Скрытый карниз*', { parse_mode: 'Markdown', ...corniceMenu(state.config) });
});

// ============ ФОТО ============
bot.on('photo', async ctx => {
  const state = getState(ctx.from.id);
  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    state.photo = Buffer.from(resp.data);
    state.photoWithGrid = null;
    state.step = 'config';
    state.config = getDefaultConfig();

    const summary = buildSummary(state.config);
    await ctx.reply(`✅ Фото получено!\n\n⚙️ *Настройте параметры:*\n\n${summary}\n\n💰 Стоимость: ${PRICE_RUB}₽`, { parse_mode: 'Markdown', ...configMenu(state.config) });
  } catch (e) {
    console.error(e);
    ctx.reply('❌ Ошибка загрузки фото');
  }
});

bot.on('document', async ctx => {
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith('image/')) return ctx.reply('❌ Отправьте изображение');
  const state = getState(ctx.from.id);
  try {
    const file = await ctx.telegram.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    state.photo = Buffer.from(resp.data);
    state.photoWithGrid = null;
    state.step = 'config';
    state.config = getDefaultConfig();

    const summary = buildSummary(state.config);
    await ctx.reply(`✅ Фото получено!\n\n⚙️ *Настройте параметры:*\n\n${summary}\n\n💰 Стоимость: ${PRICE_RUB}₽`, { parse_mode: 'Markdown', ...configMenu(state.config) });
  } catch (e) {
    console.error(e);
    ctx.reply('❌ Ошибка загрузки фото');
  }
});

// ============ ГЕНЕРАЦИЯ (ДВУХЭТАПНАЯ С ПАУЗОЙ) ============
bot.action('generate', async ctx => {
  const state = getState(ctx.from.id);
  const userId = ctx.from.id;

  if (!state.photo) return ctx.answerCbQuery('Сначала отправьте фото!');
  if (state.processing) return ctx.answerCbQuery('Уже генерируется...');

  const bal = getUserBalance(userId);
  if (bal < PRICE_RUB && !isAdmin(userId)) return ctx.answerCbQuery('Недостаточно средств!');

  state.processing = true;
  await ctx.answerCbQuery();

  const summary = buildSummary(state.config);
  let statusMsg = await ctx.reply('⏳ *Этап 1/2: Создание базового потолка...*\n\nГенерирую чистый потолок (30-60 сек)', { parse_mode: 'Markdown' });

  try {
    // ============ ЭТАП 1: Чистый потолок с цветом и текстурой ============
    const imageUri = `data:image/jpeg;base64,${state.photo.toString('base64')}`;
    const color = COLORS[state.config.color]?.en || 'pure white';

    let prompt1 = `Replace the ceiling in this interior photo with a new modern stretch ceiling.\n\n`;
    prompt1 += `Remove ALL existing ceiling elements: tiles, panels, grid, lights, fixtures, tracks.\n\n`;
    prompt1 += `New ceiling: ${color} `;

    if (state.config.texture === 'glossy') {
      prompt1 += "GLOSSY WET-LOOK MIRROR-LIKE REFLECTIVE LACQUERED surface. The ceiling MUST clearly reflect the room like a mirror - you should see reflections of furniture, windows, floor on the glossy ceiling. Shiny polished lacquer finish.";
    } else if (state.config.texture === 'satin') {
      prompt1 += "satin pearl finish with soft silky sheen, subtle shimmer.";
    } else {
      prompt1 += "smooth MATTE FLAT surface with absolutely no reflections, like painted drywall.";
    }

    prompt1 += "\n\nKeep all walls, floor, furniture exactly unchanged. Photorealistic result.";

    console.log(`[${userId}] === STAGE 1 ===`);
    console.log(`[${userId}] ${prompt1}`);

    const pred1 = await replicate.predictions.create({
      model: "black-forest-labs/flux-kontext-pro",
      input: {
        prompt: prompt1,
        input_image: imageUri,
        aspect_ratio: "match_input_image",
        safety_tolerance: 5,
        output_format: "jpg",
        output_quality: 90
      }
    });

    let result1 = pred1;
    while (result1.status !== 'succeeded' && result1.status !== 'failed') {
      await new Promise(r => setTimeout(r, 2000));
      result1 = await replicate.predictions.get(result1.id);
    }

    if (result1.status !== 'succeeded' || !result1.output) {
      throw new Error(result1.error || 'Stage 1 failed');
    }

    const stage1Url = Array.isArray(result1.output) ? result1.output[0] : result1.output;
    console.log(`[${userId}] Stage 1 done: ${stage1Url}`);

    // Отправляем первое изображение (остаётся в чате)
    await ctx.replyWithPhoto({ url: stage1Url }, {
      caption: `✅ *Этап 1 завершён*\n\n🎨 Базовый потолок: ${COLORS[state.config.color]?.label} ${TEXTURES[state.config.texture]?.label}`,
      parse_mode: 'Markdown'
    });

    // Удаляем сообщение статуса
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    // ============ ПАУЗА 65 СЕКУНД С ТАЙМЕРОМ ============
    const WAIT_SECONDS = 65;
    let timerMsg = await ctx.reply(`⏳ *Ожидание перед этапом 2...*\n\n⏱ Осталось: ${WAIT_SECONDS} сек\n\n_Пауза необходима из-за лимитов API_`, { parse_mode: 'Markdown' });

    // Обновляем таймер каждые 10 секунд
    for (let remaining = WAIT_SECONDS; remaining > 0; remaining -= 10) {
      await new Promise(r => setTimeout(r, Math.min(10000, remaining * 1000)));
      remaining = Math.max(0, remaining - 10);
      if (remaining > 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          timerMsg.message_id,
          null,
          `⏳ *Ожидание перед этапом 2...*\n\n⏱ Осталось: ${remaining} сек\n\n_Пауза необходима из-за лимитов API_`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    }

    // ============ ЭТАП 2: Добавление деталей ============
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      timerMsg.message_id,
      null,
      '⏳ *Этап 2/2: Добавление деталей...*\n\nСпоты, профили, карниз (30-60 сек)',
      { parse_mode: 'Markdown' }
    ).catch(() => {});

    // Скачиваем результат первого этапа
    const stage1Resp = await axios.get(stage1Url, { responseType: 'arraybuffer' });
    const stage1Buffer = Buffer.from(stage1Resp.data);
    const image2Uri = `data:image/jpeg;base64,${stage1Buffer.toString('base64')}`;

    // Строим промпт для второго этапа
    let prompt2 = `Modify ONLY the ceiling in this interior photo. Keep the ceiling color and texture exactly as is.\n\n`;

    // Определяем нужны ли детали
    const needsDetails = state.config.spots.enabled ||
                        state.config.chandelier.enabled ||
                        state.config.lightLines.enabled ||
                        state.config.cornice.enabled ||
                        Object.values(state.config.profiles).some(p => p !== 'standard');

    if (!needsDetails) {
      // Если деталей нет - просто возвращаем первый результат
      console.log(`[${userId}] No details needed, using stage 1 result`);
      await ctx.telegram.deleteMessage(ctx.chat.id, timerMsg.message_id).catch(() => {});

      if (!isAdmin(userId)) deductBalance(userId, PRICE_RUB);
      appData.totalGenerations++;
      appData.totalRevenue += PRICE_RUB;
      saveData();

      await ctx.reply(`✅ *Готово!*\n\n${summary}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Изменить настройки', 'back_config')],
          [Markup.button.callback('📸 Новое фото', 'start')],
          [Markup.button.callback('🏠 Меню', 'menu')]
        ])
      });
      state.processing = false;
      return;
    }

    // Собираем список ВСЕХ изменений с номерами
    let changes = [];
    let changeNum = 1;

    // Профили по стенам
    const walls = ['top', 'right', 'bottom', 'left'];
    const wallNames = { top: 'back/far', right: 'right', bottom: 'front/near camera', left: 'left' };

    // Сначала собираем какие стены с каким профилем
    const shadowWalls = [];
    const floatingWalls = [];
    const standardWalls = [];

    for (const wall of walls) {
      const profile = state.config.profiles[wall];
      if (profile === 'shadow') {
        shadowWalls.push(wallNames[wall]);
      } else if (profile === 'floating') {
        floatingWalls.push(wallNames[wall]);
      } else {
        standardWalls.push(wallNames[wall]);
      }
    }

    // Теневой профиль - ОЧЕНЬ ТОЧНОЕ ОПИСАНИЕ
    if (shadowWalls.length > 0) {
      changes.push(`${changeNum}. SHADOW GAP PERIMETER: At the ${shadowWalls.join(' and ')} wall(s), there must be a thin BLACK LINE (1cm wide) running along the EDGE of the ceiling where it meets the wall. This dark line goes ALONG THE WALL EDGE at the perimeter - NOT across the middle of the ceiling! It's like a dark border/frame at the ceiling edge near that wall.`);
      changeNum++;
    }

    // Парящий профиль - ОЧЕНЬ ТОЧНОЕ ОПИСАНИЕ
    if (floatingWalls.length > 0) {
      const noGlowWalls = [...shadowWalls, ...standardWalls];
      changes.push(`${changeNum}. LED COVE LIGHTING at ${floatingWalls.join(' and ')} wall(s): Add hidden LED strip that creates a GLOW at the junction between ceiling and the ${floatingWalls.join('/')} wall. The light shines from a gap at the ceiling EDGE (perimeter), illuminating the top of that wall with soft light. This creates a "floating ceiling" effect at that wall only.${noGlowWalls.length > 0 ? ` DO NOT add any glow at ${noGlowWalls.join(', ')} walls.` : ''}`);
      changeNum++;
    }

    // Споты - МАКСИМАЛЬНО ЖЁСТКИЕ ТРЕБОВАНИЯ
    if (state.config.spots.enabled) {
      const count = state.config.spots.count || 6;
      const countWords = { 4: 'FOUR', 6: 'SIX', 8: 'EIGHT', 10: 'TEN', 12: 'TWELVE' };
      const countWord = countWords[count] || count.toString();

      // Описание расположения в зависимости от количества
      let arrangement = '';
      if (state.config.spots.layout === 'grid') {
        if (count === 4) arrangement = 'arranged in 2 rows with 2 spotlights in each row';
        else if (count === 6) arrangement = 'arranged in 2 rows with 3 spotlights in each row (total 6)';
        else if (count === 8) arrangement = 'arranged in 2 rows with 4 spotlights in each row (total 8)';
        else if (count === 10) arrangement = 'arranged in 2 rows with 5 spotlights in each row (total 10)';
        else if (count === 12) arrangement = 'arranged in 3 rows with 4 spotlights in each row (total 12)';
        else arrangement = 'evenly distributed across the ceiling';
      } else if (state.config.spots.layout === 'perimeter') {
        arrangement = `evenly spaced around the perimeter/edges of the ceiling`;
      } else if (state.config.spots.layout === 'center') {
        arrangement = `grouped together in the center area of the ceiling`;
      }

      let spotsText = `${changeNum}. RECESSED SPOTLIGHTS - VERY IMPORTANT: You MUST add EXACTLY ${count} (${countWord}) round recessed ceiling spotlights/downlights. Each spotlight is a small circular light fixture (7-8cm diameter) embedded flush into the ceiling, and ALL of them must be turned ON (glowing/lit). Layout: ${arrangement}. Count the spotlights: ${Array.from({length: count}, (_, i) => i + 1).join(', ')}. Must be exactly ${count} lights, all illuminated!`;
      changes.push(spotsText);
      changeNum++;
    }

    // Люстра
    if (state.config.chandelier.enabled) {
      const style = CHANDELIER_STYLES[state.config.chandelier.style]?.en || 'modern pendant light';
      changes.push(`${changeNum}. CHANDELIER: Add a ${style} hanging from the center of the ceiling.`);
      changeNum++;
    }

    // Световые линии
    if (state.config.lightLines.enabled) {
      const dir = LIGHT_LINE_DIRECTIONS[state.config.lightLines.direction]?.en || 'lengthwise';
      changes.push(`${changeNum}. LED LIGHT LINES: Add ${state.config.lightLines.count} glowing white LED strip line(s) built into the ceiling, ${dir}.`);
      changeNum++;
    }

    // Карниз - подробное описание
    if (state.config.cornice.enabled) {
      changes.push(`${changeNum}. HIDDEN CURTAIN NICHE: Near the window, add a rectangular recess/slot in the ceiling (approximately 10-15cm wide) that runs parallel to the window wall. This is where curtains would hang from - the curtain rod is hidden inside this ceiling slot. The niche looks like a dark rectangular gap cut into the ceiling near the window.`);
      changeNum++;
    }

    // Формируем финальный промпт
    prompt2 += `YOU MUST MAKE THE FOLLOWING ${changes.length} CHANGES TO THE CEILING:\n\n`;
    prompt2 += changes.join('\n\n');
    prompt2 += `\n\nIMPORTANT: All ${changes.length} changes listed above are REQUIRED. Do not skip any of them. Keep walls, floor, furniture unchanged. Photorealistic result.`;

    console.log(`[${userId}] === STAGE 2 ===`);
    console.log(`[${userId}] ${prompt2}`);

    const pred2 = await replicate.predictions.create({
      model: "black-forest-labs/flux-kontext-pro",
      input: {
        prompt: prompt2,
        input_image: image2Uri,
        aspect_ratio: "match_input_image",
        safety_tolerance: 5,
        output_format: "jpg",
        output_quality: 90
      }
    });

    let result2 = pred2;
    while (result2.status !== 'succeeded' && result2.status !== 'failed') {
      await new Promise(r => setTimeout(r, 2000));
      result2 = await replicate.predictions.get(result2.id);
    }

    if (result2.status !== 'succeeded' || !result2.output) {
      throw new Error(result2.error || 'Stage 2 failed');
    }

    const stage2Url = Array.isArray(result2.output) ? result2.output[0] : result2.output;
    console.log(`[${userId}] Stage 2 done: ${stage2Url}`);

    // Удаляем сообщение таймера
    await ctx.telegram.deleteMessage(ctx.chat.id, timerMsg.message_id).catch(() => {});

    // ============ ФИНАЛЬНЫЙ РЕЗУЛЬТАТ ============
    if (!isAdmin(userId)) deductBalance(userId, PRICE_RUB);
    appData.totalGenerations++;
    appData.totalRevenue += PRICE_RUB;
    saveData();

    // Отправляем второе изображение (тоже остаётся в чате)
    await ctx.replyWithPhoto({ url: stage2Url }, {
      caption: `✅ *Этап 2 завершён - Готово!*\n\n${summary}`,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Изменить настройки', 'back_config')],
        [Markup.button.callback('📸 Новое фото', 'start')],
        [Markup.button.callback('🏠 Меню', 'menu')]
      ])
    });

  } catch (e) {
    console.error(`[${userId}] Error:`, e.message);
    await ctx.reply('❌ Ошибка генерации: ' + e.message.substring(0, 100), Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Повторить', 'generate')],
      [Markup.button.callback('🏠 Меню', 'menu')]
    ]));
  } finally {
    state.processing = false;
  }
});

// ============ АДМИН ============
bot.action('admin', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.answerCbQuery();
  await ctx.editMessageText(`👑 *Админ-панель*\n\n📊 Генераций: ${appData.totalGenerations}\n💰 Выручка: ${appData.totalRevenue}₽`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🏢 Компании', 'adm_comp'), Markup.button.callback('👤 Частники', 'adm_ind')],
      [Markup.button.callback('🔙 Меню', 'menu')]
    ])
  });
});

bot.action('adm_comp', async ctx => {
  const comps = Object.entries(appData.companies);
  let msg = '🏢 *Компании:*\n\n' + (comps.length ? '' : 'Пусто');
  const btns = comps.map(([id, c]) => [Markup.button.callback(`${c.name} (${c.balance}₽)`, `comp_${id}`)]);
  btns.push([Markup.button.callback('➕ Добавить', 'add_comp')], [Markup.button.callback('🔙 Назад', 'admin')]);
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

bot.action('add_comp', async ctx => {
  getState(ctx.from.id).adminMode = 'add_company';
  await ctx.answerCbQuery();
  await ctx.editMessageText('Введите название компании:', Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm_comp')]]));
});

bot.action(/^comp_(.+)$/, async ctx => {
  const id = ctx.match[1], comp = appData.companies[id];
  if (!comp) return ctx.answerCbQuery('Не найдена');
  const emps = Object.entries(appData.users).filter(([,u]) => u.companyId === id);
  let msg = `🏢 *${comp.name}*\n💰 ${comp.balance}₽\n\n` + (emps.length ? emps.map(([,u]) => `• ${u.name}`).join('\n') : '');
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('➕ Сотрудник', `addemp_${id}`), Markup.button.callback('💰 Пополнить', `topup_${id}`)],
    [Markup.button.callback('🗑 Удалить', `delcomp_${id}`)], [Markup.button.callback('🔙 Назад', 'adm_comp')]
  ])});
});

bot.action(/^addemp_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.adminMode = 'add_employee'; state.tempData = { companyId: ctx.match[1] };
  await ctx.answerCbQuery();
  await ctx.editMessageText('Введите Telegram ID:', Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `comp_${ctx.match[1]}`)]]));
});

bot.action(/^topup_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.adminMode = 'topup_company'; state.tempData = { companyId: ctx.match[1] };
  await ctx.answerCbQuery();
  await ctx.editMessageText('Введите сумму:', Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `comp_${ctx.match[1]}`)]]));
});

bot.action(/^delcomp_(.+)$/, async ctx => {
  const id = ctx.match[1];
  Object.keys(appData.users).forEach(uid => { if (appData.users[uid].companyId === id) delete appData.users[uid]; });
  delete appData.companies[id]; saveData();
  await ctx.answerCbQuery('Удалено');
  await ctx.editMessageText('✅ Удалено', Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'adm_comp')]]));
});

bot.action('adm_ind', async ctx => {
  const inds = Object.entries(appData.individuals);
  let msg = '👤 *Частники:*\n\n' + (inds.length ? '' : 'Пусто');
  const btns = inds.map(([id, i]) => [Markup.button.callback(`${i.name} (${i.balance}₽)`, `ind_${id}`)]);
  btns.push([Markup.button.callback('➕ Добавить', 'add_ind')], [Markup.button.callback('🔙 Назад', 'admin')]);
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

bot.action('add_ind', async ctx => {
  const state = getState(ctx.from.id);
  state.adminMode = 'add_individual'; state.tempData = {};
  await ctx.answerCbQuery();
  await ctx.editMessageText('Введите Telegram ID:', Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm_ind')]]));
});

bot.action(/^ind_(.+)$/, async ctx => {
  const id = ctx.match[1], ind = appData.individuals[id];
  if (!ind) return ctx.answerCbQuery('Не найден');
  await ctx.answerCbQuery();
  await ctx.editMessageText(`👤 *${ind.name}*\n💰 ${ind.balance}₽`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('💰 Пополнить', `topupind_${id}`)],
    [Markup.button.callback('🗑 Удалить', `delind_${id}`)], [Markup.button.callback('🔙 Назад', 'adm_ind')]
  ])});
});

bot.action(/^topupind_(.+)$/, async ctx => {
  const state = getState(ctx.from.id);
  state.adminMode = 'topup_individual'; state.tempData = { odId: ctx.match[1] };
  await ctx.answerCbQuery();
  await ctx.editMessageText('Введите сумму:', Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `ind_${ctx.match[1]}`)]]));
});

bot.action(/^delind_(.+)$/, async ctx => {
  delete appData.individuals[ctx.match[1]]; delete appData.users[ctx.match[1]]; saveData();
  await ctx.answerCbQuery('Удалено');
  await ctx.editMessageText('✅ Удалено', Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'adm_ind')]]));
});

// ============ ТЕКСТ ============
bot.on('text', async ctx => {
  if (ctx.message.text.startsWith('/')) return;
  const state = getState(ctx.from.id);
  const text = ctx.message.text.trim().toUpperCase();

  // Обработка координат спотов
  if (state.step === 'spots_positions') {
    const coords = text.split(/[,\s]+/).filter(c => /^[A-T]\d{1,2}$/.test(c));
    if (coords.length > 0) {
      state.config.spots.positions = coords;
      state.step = 'config';
      await ctx.reply(`✅ Позиции спотов: ${coords.join(', ')}`, {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад к настройкам', 'back_config')]])
      });
    } else {
      await ctx.reply('❌ Неверный формат. Используйте: K5, L10, M15');
    }
    return;
  }

  // Обработка координаты люстры
  if (state.step === 'chandelier_position') {
    if (/^[A-T]\d{1,2}$/.test(text)) {
      state.config.chandelier.position = text;
      state.step = 'config';
      await ctx.reply(`✅ Позиция люстры: ${text}`, {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад к настройкам', 'back_config')]])
      });
    } else {
      await ctx.reply('❌ Неверный формат. Используйте: J10 (буква A-T + число 1-20)');
    }
    return;
  }

  // Админские команды
  if (!isAdmin(ctx.from.id) || !state.adminMode) {
    return ctx.reply('📸 Отправьте фото для начала', mainMenu(isAdmin(ctx.from.id)));
  }

  const rawText = ctx.message.text.trim();

  if (state.adminMode === 'add_company') {
    const id = 'comp_' + Date.now();
    appData.companies[id] = { name: rawText, balance: 0 }; saveData();
    state.adminMode = null;
    return ctx.reply(`✅ "${rawText}" создана`, Markup.inlineKeyboard([[Markup.button.callback('📂 Открыть', `comp_${id}`)]]));
  }

  if (state.adminMode === 'add_employee') {
    if (!state.tempData.odId) {
      if (!/^\d+$/.test(rawText)) return ctx.reply('❌ ID должен быть числом');
      state.tempData.odId = rawText;
      return ctx.reply('Введите имя:');
    } else {
      appData.users[state.tempData.odId] = { name: rawText, companyId: state.tempData.companyId }; saveData();
      state.adminMode = null;
      return ctx.reply(`✅ ${rawText} добавлен`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', `comp_${state.tempData.companyId}`)]]));
    }
  }

  if (state.adminMode === 'topup_company') {
    const amt = parseInt(rawText);
    if (isNaN(amt) || amt <= 0) return ctx.reply('❌ Введите число');
    appData.companies[state.tempData.companyId].balance += amt; saveData();
    state.adminMode = null;
    return ctx.reply(`✅ +${amt}₽`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', `comp_${state.tempData.companyId}`)]]));
  }

  if (state.adminMode === 'add_individual') {
    if (!state.tempData.odId) {
      if (!/^\d+$/.test(rawText)) return ctx.reply('❌ ID должен быть числом');
      state.tempData.odId = rawText;
      return ctx.reply('Введите имя:');
    } else {
      appData.individuals[state.tempData.odId] = { name: rawText, balance: 0 };
      appData.users[state.tempData.odId] = { name: rawText }; saveData();
      state.adminMode = null;
      return ctx.reply(`✅ ${rawText} добавлен`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'adm_ind')]]));
    }
  }

  if (state.adminMode === 'topup_individual') {
    const amt = parseInt(rawText);
    if (isNaN(amt) || amt <= 0) return ctx.reply('❌ Введите число');
    appData.individuals[state.tempData.odId].balance += amt; saveData();
    state.adminMode = null;
    return ctx.reply(`✅ +${amt}₽`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', `ind_${state.tempData.odId}`)]]));
  }
});

// ============ ЗАПУСК ============
bot.launch().then(() => {
  console.log('🚀 Бот запущен! (2-stage, 65s pause)');
  console.log(`   Админы: ${ADMIN_IDS.join(', ')}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
