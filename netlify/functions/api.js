/*  netlify/functions/api.js  */
// 1️⃣  额外引入 serverless-http
const serverless = require('serverless-http');

// 2️⃣  下面是你原来的 server.js 完整内容（一行未改）
require('dotenv')。config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();
const upload = multer({ dest: '/tmp' });

app。use(cors());
app。use(express。json({ limit: '8mb' }));
app。set('trust proxy'， 1);

// -------------------- 原 server.js 代码开始 --------------------
const PORT = process.env.PORT || 3000;
const Database = require('better-sqlite3');
const db = new Database('/tmp/stats.db');
db。exec(`
  CREATE TABLE IF NOT EXISTS upload_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);



const GEMINI_PROXY_TARGET = process.env.GEMINI_PROXY_TARGET || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const CUSTOM_KEYWORDS_ENV = process.env.CUSTOM_KEYWORDS || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

console.log('ChatGPT Key:', GEMINI_API_KEY ? '已设置' : '未设置');
console.log('Custom Keywords (from .env):', CUSTOM_KEYWORDS_ENV || '未设置');
console.log('GitHub Token:', GITHUB_TOKEN ? '已设置' : '未设置');

// --- New Feature: Rate Limiting & Caching ---
const RATE_LIMIT_WINDOW_MS = 1 * 60 * 1000; // 2 minute
const MAX_REQUESTS_PER_WINDOW = 1; // 1 requests per minute
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const requestTracker = new Map();
const analysisCache = new Map();

// Middleware for rate limiting
const rateLimiter = (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();

    const requests = requestTracker.get(ip) || [];
    const recentRequests = requests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);

    if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
        req.rateLimited = true;
    }

    recentRequests.push(now);
    requestTracker.set(ip, recentRequests);

    next();
};

// Periodically clean up old entries to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of requestTracker.entries()) {
        const validTimestamps = timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
        if (validTimestamps.length > 0) {
            requestTracker.set(ip, validTimestamps);
        } else {
            requestTracker.delete(ip);
        }
    }
    for (const [hash, data] of analysisCache.entries()) {
        if (now - data.timestamp > CACHE_TTL_MS) {
            analysisCache.delete(hash);
        }
    }
    console.log(`Cleanup complete. Tracked IPs: ${requestTracker.size}, Cached items: ${analysisCache.size}`);
}, 10 * 60 * 1000); // Run cleanup every 10 minutes

app.use(express.static(__dirname));

async function callGemini(log, proxyTarget) {
    const target = proxyTarget || GEMINI_PROXY_TARGET;
    const url = `${target}v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `请分析以下Minecraft日志，给出主要错误原因、其他原因和建议，并在给出快速解决方案，快速解决方案尽量简短，错误原因尽量详细：\n${log}`;
    try {
        const res = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }]
        });
        return res.data.candidates?.[0]?.content?.parts?.[0]?.text || 'Gemini无返回内容';
    } catch (e) {
        console.error('ChatGPT API 调用异常:', e.response?.data || e.message);
        return 'ChatGPT API 调用失败,请重试: ' + (e.response?.data?.error?.message || e.message);
    }
}

function extractInfo(log) {
    const info = {};
    const patterns = {
        launcher_name: [
            { regex: /\[Pre-Init\] (PojavLauncher INIT!|Amethyst INIT!)/, name: 'Amethyst_iOS' },
            { regex: /Info: Launcher version:/, name: 'Zalith Launcher' },
            { regex: /FCL Version:/, name: 'Fold Craft Launcher' }
        ],
        launcher_version: [
            { regex: /\[Pre-Init\] Version: (.*?)\n/, key: 'Launcher Version' }, // Amethyst_iOS
            { regex: /Info: Launcher version: (.*?) \(/, key: 'Launcher Version' }, // Zalith Launcher
            { regex: /FCL Version: (.*?)\n/, key: 'Launcher Version' } // Fold Craft Launcher
        ],
        architecture: [
            { regex: /Architecture: (.*?)($|\n)/, key: 'Architecture' } // General: Zalith, Fold Craft
        ],
        device: [
            { regex: /\[Pre-Init\] Device: (.*?)\n/, key: 'Device' }, // Amethyst_iOS
            { regex: /Info: Device model: (.*?)\n/, key: 'Device Model' }, // Zalith Launcher
            { regex: /Device: (.*?)\n/, key: 'Device' } // Fold Craft Launcher
        ],
        os: [
            { regex: /\[Pre-Init\] (iOS \d+\.\d+\.?\d*? \((.*?)\))\n/, key: 'OS Version' }, // Amethyst_iOS with build number
            { regex: /\[Pre-Init\] (iOS \d+\.\d+)/, key: 'OS Version' }, // Amethyst_iOS
            { regex: /Android SDK: (.*?)($|\n)/, key: 'Android SDK' } // Zalith, Fold Craft
        ],
        java_version: [
            { regex: /Info: Java Runtime: (.*?)\n/, key: 'Java Runtime' }, // Zalith Launcher
            { regex: /Java Version: (.*?)($|\n)/, key: 'Java Version' }, // Fold Craft Launcher
            { regex: /java-(\d+)-openjdk/, key: 'Java Version' } // Existing, might catch some cases
        ],
        renderer: [
            { regex: /Info: Renderer: (.*?)\n/, key: 'Renderer' }, // Zalith Launcher
            { regex: /Renderer: (.*?)\n/, key: 'Renderer' } // Fold Craft Launcher
        ],
        minecraft_version: [
            { regex: /Info: Selected Minecraft version: (.*?)\n/, key: 'Minecraft Version' }, // Zalith Launcher
            { regex: /Launching Minecraft .*?-([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-rc[0-9]+)?)\n/, key: 'Minecraft Version' } // Existing, general
        ],
        commit: [
            { regex: /Commit: (.*?)\n/, key: 'Commit' } // Amethyst_iOS
        ],
        cpu: [
            { regex: /CPU: (.*?)\n/, key: 'CPU' } // Fold Craft Launcher
        ],
        language: [
            { regex: /Language: (.*?)\n/, key: 'Language' } // Fold Craft Launcher
        ],
        api_version: [
            { regex: /Info: API version: (.*?)\n/, key: 'API Version' } // Zalith Launcher
        ],
        fcl_version_code: [
            { regex: /FCL Version Code: (.*?)\n/, key: 'FCL Version Code' } // Fold Craft Launcher
        ]
    };

    const detectedKeywords = new Set();

    for (const patternObj of patterns.launcher_name) {
        if (log.match(patternObj.regex)) {
            info.launcher_name = patternObj.name;
            break;
        }
    }

    for (const category in patterns) {
        if (category === 'launcher_name') {
            continue;
        }

        if (category === 'keyword_regex') {
            const match = log.match(/\[(.*?)\] Failed to load/);
            if (match && match[1] !== undefined) detectedKeywords.add(match[1].trim());
            continue;
        }

        for (const patternObj of patterns[category]) {
            const match = log.match(patternObj.regex);
            if (match && match[1] !== undefined) {
                info[patternObj.key] = match[1].trim();
                break;
            }
        }
    }

    const customKeywords = CUSTOM_KEYWORDS_ENV.split('|').map(k => k.trim()).filter(k => k.length > 0);
    for (const customKw of customKeywords) {
        if (log.includes(customKw)) detectedKeywords.add(customKw);
    }
    if (detectedKeywords.size > 0) info.keyword = Array.from(detectedKeywords).join(', ');
    return info;
}


function quickAnalysis(log) {
    const results = [];
    const checks = [
        {
            keywords: ["A potential solution has been determined:", "A potential solution has been determined, this may resolve your problem:", "确定了一种可能的解决方法，这样做可能会解决你的问题："],
            logic: 'any',
            dynamicReason: (log) => {
                const startIndexMatch = log.match(/(A potential solution has been determined:|A potential solution has been determined, this may resolve your problem:|确定了一种可能的解决方法，这样做可能会解决你的问题：)\s*[\n\r]+/);

                if (startIndexMatch) {
                    const startIndex = startIndexMatch.index + startIndexMatch[0].length;
                    const relevantLogSection = log.substring(startIndex);

                    const solutionLines = [];
                    const lineRegex = /^[\t ]*-\s*(.+)/gm;
                    let match;
                    while ((match = lineRegex.exec(relevantLogSection)) !== null) {
                        solutionLines.push(match[0].trimEnd());
                    }

                    if (solutionLines.length > 0) {
                        return `Fabric 提供了解决方案：\n${solutionLines.join('\n')}\n\n请根据上述信息进行对应处理，如果看不懂英文可以使用翻译软件`;
                    }
                }
                return null;
            }
        },
        {
            keywords: ["An exception was thrown, the game will display an error screen and halt."],
            dynamicReason: (log) => {
                const errorMessageMatch = log.match(/(?<=the game will display an error screen and halt\.[\n\r]+Exception: )[\s\S]+?(?=\n\tat|$)/);
                if (errorMessageMatch) {
                    return `Forge 提供了以下错误信息：\n${errorMessageMatch[0].trim()}\n\n请根据上述信息进行对应处理，如果看不懂英文可以使用翻译软件`;
                }
                return null;
            }
        },
        {
            keywords: ["java.lang.OutOfMemoryError", "an out of memory error", "Out of Memory Error"],
            reason: "Minecraft 内存不足，导致其无法继续运行\n这很可能是因为电脑内存不足、游戏分配的内存不足，或是配置要求过高\n\n你可以尝试在启动设置中增加为游戏分配的内存，并删除配置要求较高的材质、Mod、光影"
        },
        {
            keywords: ["Could not reserve enough space"],
            logic: 'all',
            reason: "你似乎正在使用 32 位 Java，这会导致 Minecraft 无法使用所需的内存，进而造成崩溃\n\n请在启动设置中改用 64 位的 Java 再启动游戏"
        },
        {
            keywords: ["Invalid maximum heap size"],
            reason: "你似乎正在使用 32 位 Java，这会导致 Minecraft 无法使用所需的内存，进而造成崩溃\n\n请在启动设置中改用 64 位 Java 再启动游戏"
        },
        {
            keywords: ["java.lang.ClassCastException: java.base/jdk", "java.lang.ClassCastException: class jdk."],
            reason: "游戏似乎因为使用 JDK，或 Java 版本过高而崩溃了\n请在启动设置中改用 JRE 8（Java 8），然后再启动游戏"
        },
        {
            keywords: ["Unsupported class file major version", "Unsupported major.minor version"],
            reason: "游戏不兼容你当前使用的 Java\n请根据游戏版本要求更换Java（例如高版本Minecraft需要Java 17），如果没有合适的 Java，可以从网络中下载、安装一个"
        },
        {
            keywords: ["Open J9 is not supported", "OpenJ9 is incompatible", ".J9VMInternals."],
            logic: 'any',
            reason: "你正在使用 OpenJ9，它与游戏不兼容\n请在启动设置中改用 HotSpot Java 再启动游戏"
        },
        {
            keywords: ["java.lang.NoSuchFieldException: ucp", "because module java.base does not export", "java.lang.ClassNotFoundException: jdk.nashorn.api.scripting.NashornScriptEngineFactory", "java.lang.ClassNotFoundException: java.lang.invoke.LambdaMetafactory"],
            logic: 'any',
            reason: "游戏不兼容你当前使用的 Java。\n请根据游戏版本要求更换Java（例如高版本Minecraft需要Java 17），如果没有合适的 Java，可以从网络中下载、安装一个"
        },
        {
            keywords: ["The driver does not appear to support OpenGL", "Couldn't set pixel format", "Pixel format not accelerated"],
            logic: 'any',
            reason: "显卡驱动不支持 OpenGL，或是显卡驱动版本过旧。\n请更新你的显卡驱动，如果还是有问题，请尝试更新或回滚驱动版本,若您使用的是笔记本电脑，请确保游戏使用的是独立显卡而非集成显卡"
        },
        {
            keywords: ["EXCEPTION_ACCESS_VIOLATION"],
            dynamicReason: (log) => {
                if (log.includes("# C [ig")) return "你的 Intel 显卡驱动不兼容，导致游戏崩溃\n请尝试更新或回滚显卡驱动版本。若您使用的是笔记本电脑，请确保游戏使用的是独立显卡而非集成显卡";
                if (log.includes("# C [atio")) return "你的 AMD 显卡驱动不兼容，导致游戏崩溃\n请尝试更新或回滚驱动版本。若您使用的是笔记本电脑，请确保游戏使用的是独立显卡而非集成显卡";
                if (log.includes("# C [nvoglv")) return "你的 Nvidia 显卡驱动不兼容，导致游戏崩溃\n请尝试更新或回滚驱动版本。若您使用的是笔记本电脑，请确保游戏使用的是独立显卡而非集成显卡";
                return null;
            }
        },
        {
            keywords: ["1282: Invalid operation"],
            reason: "可能是光影或资源包与游戏不兼容导致 OpenGL 错误\n请尝试删除光影和资源包，或更换其他兼容的版本"
        },
        {
            keywords: ["Maybe try a lower resolution resourcepack?"],
            reason: "材质包过大或显卡配置不足\n请尝试更换一个分辨率较低的材质包，或升级你的显卡"
        },
        {
            keywords: ["The system is out of physical RAM or swap space"],
            reason: "系统物理内存或虚拟内存不足\n请关闭其他程序，或尝试增加虚拟内存"
        },
        {
            keywords: ["Manually triggered debug crash"],
            reason: "玩家手动触发了调试崩溃"
        },
        {
            keywords: ["The directories below appear to be extracted jar files. Fix this before you continue.", "Extracted mod jars found, loading will NOT continue"],
            logic: 'any',
            reason: "Mod 文件被解压了，这会导致游戏无法正常加载\n请删除这些被解压的 Mod 文件，然后重新下载没有被解压的 Mod 文件"
        },
        {
            keywords: ["java.lang.ClassNotFoundException: org.spongepowered.asm.launch.MixinTweaker"],
            reason: "MixinBootstrap 缺失，这通常是因为 Mod 加载器安装不完整，或是游戏版本与 Mod 不匹配\n请重新安装 Mod 加载器，或检查 Mod 是否与当前游戏版本兼容"
        },
        {
            keywords: ["java.lang.RuntimeException: Shaders Mod detected. Please remove it, OptiFine has built-in support for shaders."],
            reason: "同时安装了 ShadersMod 和 OptiFine，这会导致冲突\n请删除 ShadersMod，OptiFine 已内置光影支持"
        },
        {
            keywords: ["java.lang.NoSuchMethodError: sun.security.util.ManifestEntryVerifier"],
            reason: "你使用的 Forge 版本过低，与当前 Java 版本不兼容\n请更新 Forge 版本，或更换兼容的 Java 版本（例如 Java 8）"
        },
        {
            keywords: ["Found multiple arguments for option fml.forgeVersion, but you asked for only one"],
            reason: "版本 Json 中存在多个 Forge 版本，这会导致冲突\n请检查你的游戏配置文件，确保只引用一个 Forge 版本"
        },
        {
            keywords: ["Cannot find launch target fmlclient", "Invalid paths argument, contained no existing paths", "libraries\\net\\minecraftforge\\fmlcore"],
            logic: 'any',
            reason: "Forge 安装不完整，或文件已损坏。\n请尝试重新安装 Forge"
        },
        {
            keywords: ["Invalid module name: '' is not a Java identifier"],
            reason: "Mod 名称包含特殊字符，导致无法加载。\n请修改 Mod 文件名，移除特殊字符"
        },
        {
            keywords: ["has been compiled by a more recent version of the Java Runtime (class file version 55.0), this version of the Java Runtime only recognizes class file versions up to", "java.lang.RuntimeException: java.lang.NoSuchMethodException: no such method: sun.misc.Unsafe.defineAnonymousClass(Class,byte[],Object[])Class/invokeVirtual", "java.lang.IllegalArgumentException: The requested compatibility level JAVA_11 could not be set. Level is not supported by the active JRE or ASM version"],
            logic: 'any',
            reason: "Mod 需要 Java 11 或更高版本才能运行，而你当前使用的 Java 版本过低\n请在启动设置中改用 Java 11 或更高版本再启动游戏"
        },
        {
            keywords: ["DuplicateModsFoundException", "Found a duplicate mod", "Found duplicate mods", "ModResolutionException: Duplicate"],
            logic: 'any',
            reason: "检测到重复安装的 Mod，这会导致冲突\n请删除重复的 Mod 文件"
        },
        {
            keywords: ["Incompatible mods found!"],
            reason: "检测到不兼容的 Mod，这会导致游戏崩溃\n请检查 Mod 列表，移除不兼容的 Mod"
        },
        {
            keywords: ["Missing or unsupported mandatory dependencies:"],
            reason: "Mod 缺少前置 Mod 或与当前 Minecraft 版本不兼容\n请检查 Mod 的依赖项和兼容性，确保所有前置 Mod 都已安装且版本正确"
        },
        {
            keywords: ["maximum id range exceeded"],
            reason: "Mod 过多导致超出 ID 限制\n请减少 Mod 的数量，或尝试调整游戏配置以增加 ID 限制"
        },
        {
            keywords: ["com.electronwill.nightconfig.core.io.ParsingException: Not enough data available"],
            reason: "NightConfig 的 Bug，这通常是 Mod 配置文件损坏导致的\n请尝试删除或重新生成 Mod 的配置文件"
        },
        {
            keywords: ["OptiFine"],
            dynamicReason: (log) => {
                if (log.includes("TRANSFORMER/net.optifine/net.optifine.reflect.Reflector.<clinit>(Reflector.java") ||
                    log.includes("java.lang.NoSuchMethodError: 'void net.minecraft.client.renderer.texture.SpriteContents.<init>") ||
                    log.includes("java.lang.NoSuchMethodError: 'java.lang.String com.mojang.blaze3d.systems.RenderSystem.getBackendDescription") ||
                    log.includes("java.lang.NoSuchMethodError: 'void net.minecraft.client.renderer.block.model.BakedQuad.<init>") ||
                    log.includes("java.lang.NoSuchMethodError: 'void net.minecraftforge.client.gui.overlay.ForgeGui.renderSelectedItemName") ||
                    log.includes("java.lang.NoSuchMethodError: 'void net.minecraft.server.level.DistanceManager") ||
                    log.includes("java.lang.NoSuchMethodError: 'net.minecraft.network.chat.FormattedText net.minecraft.client.gui.Font.ellipsize") ||
                    (log.includes("java.lang.NoSuchMethodError: net.minecraft.world.server.ChunkManager$ProxyTicketManager.shouldForceTicks(J)Z") && log.includes("OptiFine")) ||
                    (log.includes("The Mod File ") && log.includes("optifine\\OptiFine") && log.includes(" has mods that were not found"))
                ) {
                    return "OptiFine 与 Forge 不兼容，或与其他 Mod 冲突\n请尝试更新 OptiFine 或 Forge 版本，或移除冲突的 Mod";
                }
                return null;
            }
        },
        {
            keywords: ["Mixin prepare failed", "Mixin apply failed", "MixinApplyError", "MixinTransformerError", "mixin.injection.throwables.", ".json] FAILED during "],
            logic: 'any',
            dynamicReason: (log) => {
                const modNameMatch1 = log.match(/(?<=from mod )[^.\/ ]+(?=\])/);
                const modNameMatch2 = log.match(/(?<=for mod )[^.\/ ]+(?= failed)/);
                const jsonNameMatches = [...log.matchAll(/(?<=^[^ \t]+[ \[({]{1})[^ \[({]+\.[^ ]+(?=\.json)/gm)];
                let modName = null;
                if (modNameMatch1) modName = modNameMatch1[0].trim();
                else if (modNameMatch2) modName = modNameMatch2[0].trim();

                if (modName) {
                    return `Mod Mixin 失败，可能与 Mod [${modName}] 有关\n请检查该 Mod 是否与当前游戏版本兼容，或尝试更新/删除该 Mod`;
                } else if (jsonNameMatches.length > 0) {
                    const jsonNames = jsonNameMatches.map(match => match[0].replace(/mixins\./, '').replace(/\.mixin$/, ''));
                    return `Mod Mixin 失败，可能与 Mod 配置文件 [${jsonNames.join(', 因为它包含特殊字符或已损坏。')}] 有关\n请检查这些配置文件是否正确，或尝试删除/重新生成`;
                }
                return null;
            }
        },
        {
            keywords: ["Caught exception from "],
            dynamicReason: (log) => {
                const modNameMatch = log.match(/(?<=Caught exception from )([^\n\r]+?)(?=\n|\r|$)/);
                if (modNameMatch) {
                    const modName = modNameMatch[1].trim();
                    return `Mod [${modName}] 导致游戏崩溃\n请检查该 Mod 是否与当前游戏版本兼容，或尝试更新/删除该 Mod`;
                }
                return null;
            }
        },
        {
            keywords: ["LoaderExceptionModCrash: Caught exception from "],
            dynamicReason: (log) => {
                const modNameMatch = log.match(/(?<=LoaderExceptionModCrash: Caught exception from )([^\n\r]+?)(?=\n|\r|$)/);
                if (modNameMatch) {
                    const modName = modNameMatch[1].trim();
                    return `Mod [${modName}] 导致游戏崩溃\n请检查该 Mod 是否与当前游戏版本兼容，或尝试更新/删除该 Mod`;
                }
                return null;
            }
        },
        {
            keywords: ["Multiple entries with same key: "],
            dynamicReason: (log) => {
                const keyMatch = log.match(/(?<=Multiple entries with same key: )[^=\n\r]+/);
                if (keyMatch) {
                    const keyName = keyMatch[0].trim();
                    return `检测到重复的键: [${keyName}]，这可能导致 Mod 冲突\n请检查您的 Mod 列表，确保没有重复的 Mod 或配置冲突`;
                }
                return null;
            }
        },
        {
            keywords: ["Failed loading config file "],
            dynamicReason: (log) => {
                const filePathMatch = log.match(/(?<=Failed loading config file )[^ \n\r]+(?= of type)/);
                const modIdMatch = log.match(/(?<=for modid )[^ \n\r]+/);
                let infoParts = [];
                if (filePathMatch) {
                    infoParts.push(`文件: ${filePathMatch[0].trim()}`);
                }
                if (modIdMatch) {
                    infoParts.push(`Mod ID: ${modIdMatch[0].trim()}`);
                }
                const modInfo = infoParts.length > 0 ? `可能与 ${infoParts.join(', ')} 有关` : '未知 Mod';
                return `Mod 配置文件损坏，${modInfo}。\n请尝试删除或重新生成该 Mod 的配置文件`;
            }
        },
    ];

    for (const check of checks) {
        let matched = false;
        if (check.logic === 'all') {
            matched = check.keywords.every(keyword => log.includes(keyword));
        } else {
            matched = check.keywords.some(keyword => log.includes(keyword));
        }

        if (matched) {
            let reasonToAdd = null;
            if (check.dynamicReason) {
                reasonToAdd = check.dynamicReason(log);
            } else {
                reasonToAdd = check.reason;
            }

            if (reasonToAdd) {
                results.push(reasonToAdd);
            }
        }
    }

    if (results.length > 0) {
        const mainProblem = results[0];
        const otherProblems = results.slice(1);
        let finalResult = `【快速分析】\n主要问题：\n${mainProblem}`;
        if (otherProblems.length > 0) {
            finalResult += `\n\n--- 其他可能的问题 ---\n\n${otherProblems.join('\n\n')}`;
        }
        return finalResult;
    }

    return "未在快速分析中发现明显问题，建议等待AI的详细分析";
}


// REMOVED old /api/gemini endpoint, its logic is now inside /api/extract

// --- MODIFIED: /api/extract now handles rate limiting, caching, and Gemini calls ---
app.post('/api/extract', upload.single('file'), rateLimiter, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '未上传文件' });
        }
        const log = fs.readFileSync(req.file.path, 'utf-8');
        fs.unlinkSync(req.file.path); // Clean up uploaded file immediately

        const logHash = crypto.createHash('sha256').update(log).digest('hex');

        // 1. Check cache first
        const cachedResult = analysisCache.get(logHash);
        if (cachedResult && (Date.now() - cachedResult.timestamp < CACHE_TTL_MS)) {
            console.log(`[Cache] HIT for hash: ${logHash.substring(0, 10)}...`);
            return res.json({ ...cachedResult, isCached: true });
        }
        console.log(`[Cache] MISS for hash: ${logHash.substring(0, 10)}...`);

        try {
            db.prepare('INSERT INTO upload_stats DEFAULT VALUES').run();
        } catch (e) {
            console.error('记录上传数据失败:', e.message);
        }


        const info = extractInfo(log);
        const quickAnalysisResult = quickAnalysis(log);
        let geminiResult = '';

        // 2. Check rate limit before calling Gemini
        if (req.rateLimited) {
            console.log(`[Rate Limit] IP ${req.ip} exceeded rate limit.`);
            geminiResult = '您在短时间内请求次数过多（限制每分钟1次），为节约资源，已跳过本次AI分析，请稍后重试';
        } else {
            console.log(`[Gemini] Calling API for IP: ${req.ip}`);
            geminiResult = await callGemini(log);
        }

        const analysisResponse = {
            info,
            quickAnalysis: quickAnalysisResult,
            gemini: geminiResult,
            rateLimited: !!req.rateLimited,
            isCached: false,
        };

        // 3. Store new, non-rate-limited result in cache
        if (!req.rateLimited) {
            analysisCache.set(logHash, {
                ...analysisResponse,
                timestamp: Date.now()
            });
            console.log(`[Cache] STORED new result for hash: ${logHash.substring(0, 10)}...`);
        }

        res.json(analysisResponse);

    } catch (error) {
        console.error('API /api/extract 发生错误:', error);
        res.status(500).json({ error: '日志提取与分析失败: ' + error.message });
    }
});



// --- OTHER APIs are unchanged ---
app.get('/api/github-info', async (req, res) => {
    const repoOwner = 'LanRhyme';
    const repoName = 'Web-MinecraftLogAnalyzer';
    const headers = {
        'User-Agent': 'Node.js Server',
        'Accept': 'application/vnd.github.v3+json'
    };

    if (GITHUB_TOKEN) {
        headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }

    try {
        const repoResponse = await axios.get(`https://api.github.com/repos/${repoOwner}/${repoName}`, { headers });
        const stars = repoResponse.data.stargazers_count;

        const commitsResponse = await axios.get(`https://api.github.com/repos/${repoOwner}/${repoName}/commits?per_page=1`, { headers });
        const lastCommitDate = commitsResponse.data[0] ? commitsResponse.data[0].commit.author.date : null;

        res.json({ stars, lastCommitDate });
    } catch (error) {
        console.error('Error fetching GitHub info:', error.response?.data || error.message);
        res.status(500).json({ error: '无法获取 GitHub 信息', details: error.message });
    }
});

app.get('/api/check-gemini-status', async (req, res) => {
    const target = GEMINI_PROXY_TARGET;
    if (!target) {
        return res.json({ status: 'error', message: 'GEMINI_PROXY_TARGET 未设置', latency: 'N/A' });
    }
    const startTime = Date.now();
    try {
        // 检查 Gemini 代理的实际 API 路径（POST 请求），超时时间提升到 10000ms
        const url = `${target}v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const prompt = '健康检查';
        await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }]
        }, { timeout: 10000 });
        const endTime = Date.now();
        const latency = endTime - startTime;
        res.json({ status: 'ok', message: 'Gemini 代理连接正常', latency: latency });
    } catch (error) {
        const endTime = Date.now();
        const latency = endTime - startTime;
        console.error('Error checking Gemini proxy status:', error.message);
        res.json({ status: 'error', message: 'Gemini 代理连接失败: ' + error.message + (error.stack ? ('\n' + error.stack) : ''), latency: latency });
    }
});


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
// -------------------- 原 server.js 代码结束 --------------------

// 3️⃣  仅导出包裹后的函数
module.exports.handler = serverless(app);
