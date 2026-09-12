"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });

const boom_1 = require("@hapi/boom");
const axios_1 = __importDefault(require("axios"));
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const Types_1 = require("../Types");
const WABinary_1 = require("../WABinary");
const crypto_2 = require("./crypto");
const generics_1 = require("./generics");
const messages_media_1 = require("./messages-media");
const Jimp = require("jimp");
const { zip } = require("fflate");
const { randomUUID } = require("crypto");

const MIMETYPE_MAP = {
    image: 'image/jpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    audio: 'audio/ogg; codecs=opus',
    sticker: 'image/webp',
    'product-catalog-image': 'image/jpeg',
};
const MessageTypeProto = {
    'image': Types_1.WAProto.Message.ImageMessage,
    'video': Types_1.WAProto.Message.VideoMessage,
    'audio': Types_1.WAProto.Message.AudioMessage,
    'sticker': Types_1.WAProto.Message.StickerMessage,
    'document': Types_1.WAProto.Message.DocumentMessage,
};
const ButtonType = WAProto_1.proto.Message.ButtonsMessage.HeaderType;

const extractUrlFromText = (text) => { var _a; return (_a = text.match(Defaults_1.URL_REGEX)) === null || _a === void 0 ? void 0 : _a[0]; };
const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text);
    if (!!getUrlInfo && url) {
        try {
            const urlInfo = await getUrlInfo(url);
            return urlInfo;
        } catch (error) {
            logger === null || logger === void 0 ? void 0 : logger.warn({ trace: error.stack }, 'url generation failed');
        }
    }
};
const assertColor = async (color) => {
    let assertedColor;
    if (typeof color === 'number') {
        assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1;
    } else {
        let hex = color.trim().replace('#', '');
        if (hex.length <= 6) {
            hex = 'FF' + hex.padStart(6, '0');
        }
        assertedColor = parseInt(hex, 16);
        return assertedColor;
    }
};

const prepareWAMessageMedia = async (message, options) => {
    const logger = options.logger;
    let mediaType;
    for (const key of Defaults_1.MEDIA_KEYS) {
        if (key in message) {
            mediaType = key;
        }
    }
    if (!mediaType) {
        throw new boom_1.Boom('Invalid media type', { statusCode: 400 });
    }
    const uploadData = {
        ...message,
        media: message[mediaType]
    };
    delete uploadData[mediaType];

    const cacheableKey = typeof uploadData.media === 'object' &&
        ('url' in uploadData.media) &&
        !!uploadData.media.url &&
        !!options.mediaCache && (
        mediaType + ':' + uploadData.media.url.toString());

    if (mediaType === 'document' && !uploadData.fileName) {
        uploadData.fileName = 'file';
    }
    if (!uploadData.mimetype) {
        uploadData.mimetype = MIMETYPE_MAP[mediaType];
    }

    if (cacheableKey) {
        const mediaBuff = options.mediaCache.get(cacheableKey);
        if (mediaBuff) {
            logger === null || logger === void 0 ? void 0 : logger.debug({ cacheableKey }, 'got media cache hit');
            const obj = Types_1.WAProto.Message.decode(mediaBuff);
            const key = `${mediaType}Message`;
            Object.assign(obj[key], { ...uploadData, media: undefined });
            return obj;
        }
    }

    const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined';
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') &&
        (typeof uploadData['jpegThumbnail'] === 'undefined');
    const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true;
    const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true;
    const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation;

    const { mediaKey, encWriteStream, bodyPath, fileEncSha256, fileSha256, fileLength, didSaveToTmpPath, } = await (options.newsletter ? messages_media_1.prepareStream : messages_media_1.encryptedStream)(uploadData.media, options.mediaTypeOverride || mediaType, {
        logger,
        saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
        opts: options.options
    });

    const fileEncSha256B64 = (options.newsletter ? fileSha256 : fileEncSha256 !== null && fileEncSha256 !== void 0 ? fileEncSha256 : fileSha256).toString('base64');

    const [{ mediaUrl, directPath, handle }] = await Promise.all([
        (async () => {
            const result = await options.upload(encWriteStream, { fileEncSha256B64, mediaType, timeoutMs: options.mediaUploadTimeoutMs });
            logger === null || logger === void 0 ? void 0 : logger.debug({ mediaType, cacheableKey }, 'uploaded media');
            return result;
        })(),
        (async () => {
            try {
                if (requiresThumbnailComputation) {
                    const { thumbnail, originalImageDimensions } = await (0, messages_media_1.generateThumbnail)(bodyPath, mediaType, options);
                    uploadData.jpegThumbnail = thumbnail;
                    if (!uploadData.width && originalImageDimensions) {
                        uploadData.width = originalImageDimensions.width;
                        uploadData.height = originalImageDimensions.height;
                        logger === null || logger === void 0 ? void 0 : logger.debug('set dimensions');
                    }
                    logger === null || logger === void 0 ? void 0 : logger.debug('generated thumbnail');
                }
                if (requiresDurationComputation) {
                    uploadData.seconds = await (0, messages_media_1.getAudioDuration)(bodyPath);
                    logger === null || logger === void 0 ? void 0 : logger.debug('computed audio duration');
                }
                if (requiresWaveformProcessing) {
                    uploadData.waveform = await (0, messages_media_1.getAudioWaveform)(bodyPath, logger);
                    logger === null || logger === void 0 ? void 0 : logger.debug('processed waveform');
                }
                if (requiresAudioBackground) {
                    uploadData.backgroundArgb = await assertColor(options.backgroundColor);
                    logger === null || logger === void 0 ? void 0 : logger.debug('computed backgroundColor audio status');
                }
            } catch (error) {
                logger === null || logger === void 0 ? void 0 : logger.warn({ trace: error.stack }, 'failed to obtain extra info');
            }
        })(),
    ]).finally(async () => {
        if (!Buffer.isBuffer(encWriteStream)) {
            encWriteStream.destroy();
        }
        if (didSaveToTmpPath && bodyPath) {
            try {
                await fs_1.promises.access(bodyPath);
                await fs_1.promises.unlink(bodyPath);
                logger === null || logger === void 0 ? void 0 : logger.debug('removed tmp file');
            } catch (error) {
                logger === null || logger === void 0 ? void 0 : logger.warn('failed to remove tmp file');
            }
        }
    });

    const obj = Types_1.WAProto.Message.fromObject({
        [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
            url: handle ? undefined : mediaUrl,
            directPath,
            mediaKey: mediaKey,
            fileEncSha256: fileEncSha256,
            fileSha256,
            fileLength,
            mediaKeyTimestamp: handle ? undefined : (0, generics_1.unixTimestampSeconds)(),
            ...uploadData,
            media: undefined
        })
    });
    if (uploadData.ptv) {
        obj.ptvMessage = obj.videoMessage;
        delete obj.videoMessage;
    }
    if (cacheableKey) {
        logger === null || logger === void 0 ? void 0 : logger.debug({ cacheableKey }, 'set cache');
        options.mediaCache.set(cacheableKey, Types_1.WAProto.Message.encode(obj).finish());
    }
    return obj;
};

const prepareDisappearingMessageSettingContent = (ephemeralExpiration) => {
    ephemeralExpiration = ephemeralExpiration || 0;
    const content = {
        ephemeralMessage: {
            message: {
                protocolMessage: {
                    type: Types_1.WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                    ephemeralExpiration
                }
            }
        }
    };
    return Types_1.WAProto.Message.fromObject(content);
};

async function processLocationThumbnail(input, options = {}) {
    const { maxWidth = 300, maxHeight = 300, quality = 80 } = options;
    let buffer;
    if (typeof input === 'string' && (input.startsWith('http://') || input.startsWith('https://'))) {
        const resp = await axios_1.default.get(input, { responseType: 'arraybuffer' });
        buffer = Buffer.from(resp.data);
    } else if (typeof input === 'string') {
        buffer = await fs_1.promises.readFile(input);
    } else if (Buffer.isBuffer(input)) {
        buffer = input;
    } else {
        throw new Error('thumbnail must be URL, path or Buffer');
    }
    const image = await Jimp.read(buffer);
    image.scaleToFit(maxWidth, maxHeight);
    return await image.quality(quality).getBufferAsync(Jimp.MIME_JPEG);
}

async function prepareAlbumMessageContent(jid, albums, options) {
    if (!Array.isArray(albums)) {
        throw new Error('albums must be an array containing media objects.');
    }
    if (albums.length === 0) {
        throw new Error('albums cannot be empty. At least one media item is required.');
    }
    const validCount = albums.filter((m) => 'image' in m || 'video' in m).length;
    if (validCount === 0) {
        throw new Error('albums contains no valid media. Use \'image\' or \'video\' keys.');
    }

    let mediaHandle;
    let mediaMsg;
    const message = [];
    const albumMsg = generateWAMessageFromContent(
        jid,
        {
            albumMessage: {
                expectedImageCount: albums.filter((item) => 'image' in item).length,
                expectedVideoCount: albums.filter((item) => 'video' in item).length,
            },
        },
        options
    );
    await options.conn.relayMessage(jid, albumMsg.message, {
        messageId: albumMsg.key.id,
    });

    for (const media of albums) {
        let content = {};
        if ('image' in media) {
            content = { image: media.image };
        } else if ('video' in media) {
            content = { video: media.video };
        } else {
            continue;
        }
        mediaMsg = await generateWAMessage(
            jid,
            { ...content, ...media },
            {
                userJid: options.userJid,
                upload: async (encFilePath, opts) => {
                    const up = await options.conn.waUploadToServer(encFilePath, {
                        ...opts,
                        newsletter: (0, WABinary_1.isJidNewsletter)(jid),
                    });
                    mediaHandle = up.handle;
                    return up;
                },
                ...options,
            }
        );
        if (mediaMsg) {
            mediaMsg.message.messageContextInfo = {
                messageSecret: (0, crypto_1.randomBytes)(32),
                messageAssociation: {
                    associationType: WAProto_1.proto.MessageAssociation.AssociationType.MEDIA_ALBUM,
                    parentMessageKey: albumMsg.key,
                },
            };
        }
        message.push(mediaMsg);
    }
    return message;
}

const generateForwardMessageContent = (message, forceForward) => {
    var _a;
    let content = message.message;
    if (!content) {
        throw new boom_1.Boom('no content in message', { statusCode: 400 });
    }
    content = normalizeMessageContent(content);
    content = WAProto_1.proto.Message.decode(WAProto_1.proto.Message.encode(content).finish());
    let key = Object.keys(content)[0];
    let score = ((_a = content[key].contextInfo) === null || _a === void 0 ? void 0 : _a.forwardingScore) || 0;
    score += message.key.fromMe && !forceForward ? 0 : 1;
    if (key === 'conversation') {
        content.extendedTextMessage = { text: content[key] };
        delete content.conversation;
        key = 'extendedTextMessage';
    }
    if (score > 0) {
        content[key].contextInfo = { forwardingScore: score, isForwarded: true };
    } else {
        content[key].contextInfo = {};
    }
    return content;
};

function extractIE(text, { extract = true, hyperlink = true, citation = true, latex = true } = {}) {
    if (!extract) return { text, ie: [], inline_entities: [] };
    const createIE = (type, ie) => {
        if (type === 'hyperlink') return {
            key: ie.key,
            metadata: {
                display_name: ie.text,
                is_trusted: ie.is_trusted,
                url: ie.url,
                __typename: 'GenAIInlineLinkItem',
            },
        };
        if (type === 'citation') return {
            key: ie.key,
            metadata: {
                reference_id: ie.reference_id,
                reference_url: ie.url,
                reference_title: ie.url,
                reference_display_name: ie.url,
                sources: [],
                __typename: 'GenAISearchCitationItem',
            },
        };
        if (type === 'latex') return {
            key: ie.key,
            metadata: {
                latex_expression: ie.text,
                latex_image: { url: ie.url, width: Number(ie.width) || 100, height: Number(ie.height) || 100 },
                font_height: Number(ie.font_height) || 83.333333333333,
                padding: Number(ie.padding) || 15,
                __typename: 'GenAILatexItem',
            },
        };
    };
    let ie = [], inline_entities = [], result = '', last = 0,
        citation_index = 1, hyperlink_index = 0, latex_index = 0, stack = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '[' && text[i - 1] !== '\\') {
            stack.push(i);
        } else if (text[i] === ']' && (text[i + 1] === '(' || text[i + 1] === '<')) {
            let start = stack.pop();
            if (start == null) continue;
            let open = text[i + 1], close = open === '(' ? ')' : '>',
                type = open === '(' ? 'link' : 'latex', end = i + 2, depth = 1;
            while (end < text.length && depth) {
                if (text[end] === open && text[end - 1] !== '\\') depth++;
                else if (text[end] === close && text[end - 1] !== '\\') depth--;
                end++;
            }
            if (depth) continue;
            let raw = text.slice(start + 1, i).trim(), url = text.slice(i + 2, end - 1).trim(), key, tag, data;
            if (type === 'latex') {
                if (!latex) continue;
                let [txt = '', width = null, height = null, font_height = null, padding = null] = raw.split('|');
                key = `LEVVI_LATEX_${latex_index++}`;
                tag = `{{${key}}}${txt || 'image'}{{/${key}}}`;
                data = { type: 'latex', ie: { key, text: txt, url, width, height, font_height, padding } };
            } else if (raw) {
                if (!hyperlink) continue;
                const trusted = !url.startsWith('!');
                if (!trusted) url = url.slice(1);
                key = `LEVVI_HYPERLINK_${hyperlink_index++}`;
                tag = `{{${key}}}${url}{{/${key}}}`;
                data = { type: 'hyperlink', ie: { key, text: raw, url, is_trusted: trusted } };
            } else {
                if (!citation) continue;
                key = `LEVVI_CITATION_${citation_index - 1}`;
                tag = `{{${key}}}${url}{{/${key}}}`;
                data = { type: 'citation', ie: { reference_id: citation_index++, key, text: '', url } };
            }
            result += text.slice(last, start) + tag;
            last = end;
            ie.push(data);
            const entity = createIE(data.type, data.ie);
            if (entity) inline_entities.push(entity);
            i = end - 1;
        }
    }
    result += text.slice(last);
    return { text: result, ie, inline_entities };
}

async function waitAllPromises(input) {
    const isPromise = (v) => v && typeof v.then === 'function';
    const isObject = (v) => v && typeof v === 'object';
    const deep = async (v) => {
        if (isPromise(v)) return deep(await v);
        if (Array.isArray(v)) return Promise.all(v.map(deep));
        if (isObject(v)) {
            const entries = await Promise.all(Object.entries(v).map(async ([k, val]) => [k, await deep(val)]));
            return Object.fromEntries(entries);
        }
        return v;
    };
    return deep(await input);
}

function tokenizer(code, lang = 'javascript') {
    const keywordsMap = {
        javascript: new Set(['break','case','catch','continue','debugger','delete','do','else','finally','for','function','if','in','instanceof','new','return','switch','this','throw','try','typeof','var','void','while','with','true','false','null','undefined','class','const','let','super','extends','export','import','yield','static','constructor','async','await','get','set']),
        typescript: new Set(['abstract','any','as','asserts','bigint','boolean','declare','enum','implements','infer','interface','is','keyof','module','namespace','never','readonly','require','number','object','override','private','protected','public','satisfies','string','symbol','type','unknown','using','from','break','case','catch','continue','do','else','finally','for','function','if','new','return','switch','this','throw','try','var','void','while','class','const','let','extends','import','export','async','await']),
        python: new Set(['False','None','True','and','as','assert','async','await','break','class','continue','def','del','elif','else','except','finally','for','from','global','if','import','in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield']),
        java: new Set(['abstract','assert','boolean','break','byte','case','catch','char','class','const','continue','default','do','double','else','enum','extends','final','finally','float','for','goto','if','implements','import','instanceof','int','interface','long','native','new','package','private','protected','public','return','short','static','strictfp','super','switch','synchronized','this','throw','throws','transient','try','void','volatile','while']),
        golang: new Set(['break','case','chan','const','continue','default','defer','else','fallthrough','for','func','go','goto','if','import','interface','map','package','range','return','select','struct','switch','type','var']),
        c: new Set(['auto','break','case','char','const','continue','default','do','double','else','enum','extern','float','for','goto','if','int','long','register','return','short','signed','sizeof','static','struct','switch','typedef','union','unsigned','void','volatile','while']),
        cpp: new Set(['alignas','alignof','and','auto','bool','break','case','catch','class','const','constexpr','continue','delete','do','double','else','enum','explicit','export','extern','false','float','for','friend','if','inline','int','long','mutable','namespace','new','noexcept','nullptr','operator','private','protected','public','return','short','signed','sizeof','static','struct','switch','template','this','throw','true','try','typedef','typename','union','unsigned','using','virtual','void','while']),
        php: new Set(['abstract','and','array','as','break','callable','case','catch','class','clone','const','continue','declare','default','do','echo','else','elseif','empty','enddeclare','endfor','endforeach','endif','endswitch','endwhile','extends','final','finally','fn','for','foreach','function','global','goto','if','implements','include','include_once','instanceof','interface','match','namespace','new','null','or','private','protected','public','require','require_once','return','static','switch','throw','trait','try','use','var','while','yield']),
        rust: new Set(['as','break','const','continue','crate','else','enum','extern','false','fn','for','if','impl','in','let','loop','match','mod','move','mut','pub','ref','return','self','Self','static','struct','super','trait','true','type','unsafe','use','where','while']),
        html: new Set(['html','head','body','div','span','p','a','img','video','audio','script','style','link','meta','form','input','button','table','tr','td','th','ul','ol','li','section','article','header','footer','nav','main']),
        bash: new Set(['if','then','else','elif','fi','for','while','do','done','case','esac','function','in','select','until','break','continue','return','export','readonly','local','declare']),
        markdown: new Set(['#','##','###','####','#####','######']),
    };
    if (!lang || lang === 'txt' || lang === 'text' || lang === 'plaintext') {
        return {
            codeBlock: [{ codeContent: code, highlightType: 0 }],
            unified_codeBlock: [{ content: code, type: 'DEFAULT' }],
        };
    }
    const TYPE_MAP = { 0:'DEFAULT', 1:'KEYWORD', 2:'METHOD', 3:'STR', 4:'NUMBER', 5:'COMMENT' };
    const keywords = keywordsMap[lang.toLowerCase()] || new Set();
    const tokens = [];
    let i = 0;
    const push = (content, type) => {
        if (!content) return;
        const last = tokens[tokens.length - 1];
        if (last && last.highlightType === type) last.codeContent += content;
        else tokens.push({ codeContent: content, highlightType: type });
    };
    const isIdentifier = (char) => {
        switch (lang.toLowerCase()) {
            case 'css': return /[a-zA-Z0-9_$-]/.test(char);
            case 'html': return /[a-zA-Z0-9_$:-]/.test(char);
            default: return /[a-zA-Z0-9_$]/.test(char);
        }
    };
    while (i < code.length) {
        const c = code[i];
        if (/\s/.test(c)) {
            let s = i;
            while (i < code.length && /\s/.test(code[i])) i++;
            push(code.slice(s, i), 0);
            continue;
        }
        if ((c === '/' && code[i + 1] === '/') || (c === '#' && ['python','bash'].includes(lang))) {
            let s = i;
            while (i < code.length && code[i] !== '\n') i++;
            push(code.slice(s, i), 5);
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            let s = i;
            const q = c;
            i++;
            while (i < code.length) {
                if (code[i] === '\\' && i + 1 < code.length) i += 2;
                else if (code[i] === q) { i++; break; }
                else i++;
            }
            push(code.slice(s, i), 3);
            continue;
        }
        if (/[0-9]/.test(c)) {
            let s = i;
            while (i < code.length && /[0-9._]/.test(code[i])) i++;
            push(code.slice(s, i), 4);
            continue;
        }
        if (/[a-zA-Z_$]/.test(c)) {
            let s = i;
            while (i < code.length && isIdentifier(code[i])) i++;
            const word = code.slice(s, i);
            let type = 0;
            if (keywords.has(word)) type = 1;
            else if (lang === 'css') {
                let j = i;
                while (j < code.length && /\s/.test(code[j])) j++;
                if (code[j] === ':') type = 1;
            } else if (lang === 'html') {
                let p = s - 1;
                while (p >= 0 && /\s/.test(code[p])) p--;
                if (code[p] === '<' || (code[p] === '/' && code[p-1] === '<')) type = 1;
            }
            if (type === 0) {
                let j = i;
                while (j < code.length && /\s/.test(code[j])) j++;
                if (code[j] === '(') type = 2;
            }
            push(word, type);
            continue;
        }
        push(c, 0);
        i++;
    }
    return {
        codeBlock: tokens,
        unified_codeBlock: tokens.map(t => ({ content: t.codeContent, type: TYPE_MAP[t.highlightType] })),
    };
}

function toTableMetadata(arr, { hyperlink = true, citation = true, latex = true } = {}) {
    if (!Array.isArray(arr) || !arr.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string'))) {
        throw new TypeError('Table must be a nested array of strings');
    }
    const [header, ...rows] = arr;
    const maxLen = Math.max(header.length, ...rows.map(r => r.length));
    const normalize = (r) => [...r, ...Array(maxLen - r.length).fill('')];
    const unified_rows = [
        { is_header: true, cells: normalize(header) },
        ...rows.map(r => ({ is_header: false, cells: normalize(r) })),
    ].map(row => {
        const markdown_cells = row.cells.map(cell => {
            const extracted = extractIE(cell, { hyperlink, citation, latex });
            return { text: extracted.text, ...(extracted.inline_entities.length ? { inline_entities: extracted.inline_entities } : {}) };
        });
        return { ...row, ...(markdown_cells.some(c => c.inline_entities?.length) ? { markdown_cells } : {}) };
    });
    const rowsMeta = unified_rows.map(r => ({
        items: r.cells,
        ...(r.is_header ? { isHeading: true } : {}),
    }));
    return { title: '', rows: rowsMeta, unified_rows };
}

function newLayout(name, data, extra = {}) {
    return {
        ...extra,
        view_model: {
            [Array.isArray(data) ? 'primitives' : 'primitive']: data,
            __typename: `GenAI${name}LayoutViewModel`,
        },
    };
}

const generateWAMessageContent = async (message, options) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    var _p, _q;
    let m = {};

    if ('text' in message) {
        const extContent = { text: message.text };
        let urlInfo = message.linkPreview;
        if (typeof urlInfo === 'undefined') {
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
        }
        if (urlInfo) {
            extContent.matchedText = urlInfo['matched-text'];
            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
            extContent.description = urlInfo.description;
            extContent.title = urlInfo.title;
            extContent.previewType = 0;
            const img = urlInfo.highQualityThumbnail;
            if (img) {
                extContent.thumbnailDirectPath = img.directPath;
                extContent.mediaKey = img.mediaKey;
                extContent.mediaKeyTimestamp = img.mediaKeyTimestamp;
                extContent.thumbnailWidth = img.width;
                extContent.thumbnailHeight = img.height;
                extContent.thumbnailSha256 = img.fileSha256;
                extContent.thumbnailEncSha256 = img.fileEncSha256;
            }
        }
        if (options.backgroundColor) {
            extContent.backgroundArgb = await assertColor(options.backgroundColor);
        }
        if (options.font) {
            extContent.font = options.font;
        }
        m.extendedTextMessage = extContent;
    } else if ('contacts' in message) {
        const contactLen = message.contacts.contacts.length;
        if (!contactLen) {
            throw new boom_1.Boom('require atleast 1 contact', { statusCode: 400 });
        }
        if (contactLen === 1) {
            m.contactMessage = Types_1.WAProto.Message.ContactMessage.fromObject(message.contacts.contacts[0]);
        } else {
            m.contactsArrayMessage = Types_1.WAProto.Message.ContactsArrayMessage.fromObject(message.contacts);
        }
    } else if ('location' in message) {
        m.locationMessage = Types_1.WAProto.Message.LocationMessage.fromObject(message.location);
    } else if ('react' in message) {
        if (!message.react.senderTimestampMs) {
            message.react.senderTimestampMs = Date.now();
        }
        m.reactionMessage = Types_1.WAProto.Message.ReactionMessage.fromObject(message.react);
    } else if ('delete' in message) {
        m.protocolMessage = {
            key: message.delete,
            type: Types_1.WAProto.Message.ProtocolMessage.Type.REVOKE
        };
    } else if ('forward' in message) {
        m = generateForwardMessageContent(message.forward, message.force);
    } else if ('disappearingMessagesInChat' in message) {
        const exp = typeof message.disappearingMessagesInChat === 'boolean' ?
            (message.disappearingMessagesInChat ? Defaults_1.WA_DEFAULT_EPHEMERAL : 0) :
            message.disappearingMessagesInChat;
        m = prepareDisappearingMessageSettingContent(exp);
    } else if ('groupInvite' in message) {
        m.groupInviteMessage = {};
        m.groupInviteMessage.inviteCode = message.groupInvite.inviteCode;
        m.groupInviteMessage.inviteExpiration = message.groupInvite.inviteExpiration;
        m.groupInviteMessage.caption = message.groupInvite.text;
        m.groupInviteMessage.groupJid = message.groupInvite.jid;
        m.groupInviteMessage.groupName = message.groupInvite.subject;
        if (options.getProfilePicUrl) {
            const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview');
            if (pfpUrl) {
                const resp = await axios_1.default.get(pfpUrl, { responseType: 'arraybuffer' });
                if (resp.status === 200) {
                    m.groupInviteMessage.jpegThumbnail = resp.data;
                }
            }
        }
    } else if ('pin' in message) {
    m.pinInChatMessage = {};
    m.messageContextInfo = {};

    m.pinInChatMessage.key = WAProto_1.proto.MessageKey.create(message.pin.key);
    m.pinInChatMessage.type = message.pin.type;
    m.pinInChatMessage.senderTimestampMs = Date.now();

    m.messageContextInfo.messageAddOnDurationInSecs =
        message.pin.type === 1 ? message.pin.time || 86400 : 0;
}  else if ('keep' in message) {
        m.keepInChatMessage = {};
        m.keepInChatMessage.key = message.keep;
        m.keepInChatMessage.keepType = message.type;
        m.keepInChatMessage.timestampMs = Date.now();
    } else if ('call' in message) {
        m = {
            scheduledCallCreationMessage: {
                scheduledTimestampMs: (_a = message.call.time) !== null && _a !== void 0 ? _a : Date.now(),
                callType: (_b = message.call.type) !== null && _b !== void 0 ? _b : 1,
                title: message.call.title
            }
        };
    } else if ('paymentInvite' in message) {
        m.paymentInviteMessage = {
            serviceType: message.paymentInvite.type,
            expiryTimestamp: message.paymentInvite.expiry
        };
    } else if ('buttonReply' in message) {
        switch (message.type) {
            case 'template':
                m.templateButtonReplyMessage = {
                    selectedDisplayText: message.buttonReply.displayText,
                    selectedId: message.buttonReply.id,
                    selectedIndex: message.buttonReply.index,
                };
                break;
            case 'plain':
                m.buttonsResponseMessage = {
                    selectedButtonId: message.buttonReply.id,
                    selectedDisplayText: message.buttonReply.displayText,
                    type: WAProto_1.proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT,
                };
                break;
        }
    } else if ('ptv' in message && message.ptv) {
        const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options);
        m.ptvMessage = videoMessage;
    } else if ('product' in message) {
        const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options);
        m.productMessage = Types_1.WAProto.Message.ProductMessage.fromObject({
            ...message,
            product: {
                ...message.product,
                productImage: imageMessage,
            }
        });
    } else if ('order' in message) {
        m.orderMessage = Types_1.WAProto.Message.OrderMessage.fromObject({
            orderId: message.order.id,
            thumbnail: message.order.thumbnail,
            itemCount: message.order.itemCount,
            status: message.order.status,
            surface: message.order.surface,
            orderTitle: message.order.title,
            message: message.order.text,
            sellerJid: message.order.seller,
            token: message.order.token,
            totalAmount1000: message.order.amount,
            totalCurrencyCode: message.order.currency
        });
    } else if ('listReply' in message) {
        m.listResponseMessage = { ...message.listReply };
    } else if ('poll' in message) {
        (_p = message.poll).selectableCount || (_p.selectableCount = 0);
        (_q = message.poll).toAnnouncementGroup || (_q.toAnnouncementGroup = false);
        if (!Array.isArray(message.poll.values)) {
            throw new boom_1.Boom('Invalid poll values', { statusCode: 400 });
        }
        if (message.poll.selectableCount < 0
            || message.poll.selectableCount > message.poll.values.length) {
            throw new boom_1.Boom(`poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`, { statusCode: 400 });
        }
        m.messageContextInfo = {
            messageSecret: message.poll.messageSecret || (0, crypto_1.randomBytes)(32),
        };
        const pollCreationMessage = {
            name: message.poll.name,
            selectableOptionsCount: message.poll.selectableCount,
            options: message.poll.values.map(optionName => ({ optionName })),
        };
        if (message.poll.toAnnouncementGroup) {
            m.pollCreationMessageV2 = pollCreationMessage;
        } else {
            if (message.poll.selectableCount === 1) {
                m.pollCreationMessageV3 = pollCreationMessage;
            } else {
                m.pollCreationMessage = pollCreationMessage;
            }
        }
    } else if ('event' in message) {
        m.messageContextInfo = {
            messageSecret: message.event.messageSecret || (0, crypto_1.randomBytes)(32),
        };
        m.eventMessage = { ...message.event };
    } else if ('inviteAdmin' in message) {
        m.newsletterAdminInviteMessage = {};
        m.newsletterAdminInviteMessage.inviteExpiration = message.inviteAdmin.inviteExpiration;
        m.newsletterAdminInviteMessage.caption = message.inviteAdmin.text;
        m.newsletterAdminInviteMessage.newsletterJid = message.inviteAdmin.jid;
        m.newsletterAdminInviteMessage.newsletterName = message.inviteAdmin.subject;
        m.newsletterAdminInviteMessage.jpegThumbnail = message.inviteAdmin.thumbnail;
    } else if ('requestPayment' in message) {
        const sticker = ((_c = message === null || message === void 0 ? void 0 : message.requestPayment) === null || _c === void 0 ? void 0 : _c.sticker) ?
            await prepareWAMessageMedia({ sticker: (_d = message === null || message === void 0 ? void 0 : message.requestPayment) === null || _d === void 0 ? void 0 : _d.sticker, ...options }, options)
            : null;
        let notes = {};
        if ((_e = message === null || message === void 0 ? void 0 : message.requestPayment) === null || _e === void 0 ? void 0 : _e.sticker) {
            notes = {
                stickerMessage: {
                    ...sticker === null || sticker === void 0 ? void 0 : sticker.stickerMessage,
                    contextInfo: (_f = message === null || message === void 0 ? void 0 : message.requestPayment) === null || _f === void 0 ? void 0 : _f.contextInfo
                }
            };
        } else if (message.requestPayment.note) {
            notes = {
                extendedTextMessage: {
                    text: message.requestPayment.note,
                    contextInfo: (_g = message === null || message === void 0 ? void 0 : message.requestPayment) === null || _g === void 0 ? void 0 : _g.contextInfo,
                }
            };
        } else {
            throw new boom_1.Boom('Invalid media type', { statusCode: 400 });
        }
        m.requestPaymentMessage = Types_1.WAProto.Message.RequestPaymentMessage.fromObject({
            expiryTimestamp: message.requestPayment.expiry,
            amount1000: message.requestPayment.amount,
            currencyCodeIso4217: message.requestPayment.currency,
            requestFrom: message.requestPayment.from,
            noteMessage: { ...notes },
            background: (_h = message.requestPayment.background) !== null && _h !== void 0 ? _h : null,
        });
    } else if ('sharePhoneNumber' in message) {
        m.protocolMessage = {
            type: WAProto_1.proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
        };
    } else if ('requestPhoneNumber' in message) {
        m.requestPhoneNumberMessage = {};
    } else if ('album' in message) {
        const imageMessages = message.album.filter(item => 'image' in item);
        const videoMessages = message.album.filter(item => 'video' in item);
        m.albumMessage = WAProto_1.proto.Message.AlbumMessage.fromObject({
            expectedImageCount: imageMessages.length,
            expectedVideoCount: videoMessages.length,
        });
    } else if ('groupStatus' in message) {
        const gs = message.groupStatus;
        if (!gs.message) throw new Error('groupStatus.message is required');
        const audienceType = gs.audienceType || 0;
        const backgroundColor = gs.backgroundArgb;
        const textColor = gs.textArgb;
        const font = gs.font;

        let messageContent = gs.message;
        if (typeof messageContent === 'string') {
            messageContent = {
                extendedTextMessage: {
                    text: messageContent,
                    contextInfo: {
                        statusAudienceMetadata: { audienceType }
                    },
                    ...(backgroundColor && { backgroundArgb: backgroundColor }),
                    ...(textColor && { textArgb: textColor }),
                    ...(font && { font: font })
                }
            };
        } else if (messageContent.extendedTextMessage) {
            if (backgroundColor) messageContent.extendedTextMessage.backgroundArgb = backgroundColor;
            if (textColor) messageContent.extendedTextMessage.textArgb = textColor;
            if (font) messageContent.extendedTextMessage.font = font;
            messageContent.extendedTextMessage.contextInfo = {
                ...messageContent.extendedTextMessage.contextInfo,
                statusAudienceMetadata: { audienceType }
            };
        } else if (
            messageContent.imageMessage ||
            messageContent.videoMessage ||
            messageContent.audioMessage ||
            messageContent.documentMessage
        ) {
            const key = Object.keys(messageContent)[0];
            if (!messageContent[key].contextInfo) {
                messageContent[key].contextInfo = {};
            }
            messageContent[key].contextInfo.statusAudienceMetadata = {
                audienceType: audienceType
            };
        }
        m = { groupStatusMessageV2: { message: messageContent } };
    } else if ('orderStatus' in message) {
        const os = message.orderStatus;
        if (!os.image) throw new Error('image is required for orderStatus');
        let imageInput = os.image;
        if (typeof imageInput === 'string' && !imageInput.startsWith('http://') && !imageInput.startsWith('https://')) {
            imageInput = await fs_1.promises.readFile(imageInput);
        }
        const media = await prepareWAMessageMedia(
            { image: imageInput },
            { upload: options.upload, ...options }
        );
        m = {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: WAProto_1.proto.Message.InteractiveMessage.create({
                        header: {
                            title: os.title || 'Order Status',
                            hasMediaAttachment: true,
                            ...media
                        },
                        body: {
                            text: os.text || 'Silakan cek status pesanan Anda.'
                        },
                        footer: {
                            text: os.footer || 'Powered by LevviCode'
                        },
                        nativeFlowMessage: {
                            buttons: [
                                {
                                    name: 'order_status',
                                    buttonParamsJson: JSON.stringify({
                                        reference_id: os.referenceId || 'LV-001',
                                        order: {
                                            status: os.status || 'PROCESSING',
                                            subtotal: {
                                                value: os.subtotalValue || 0,
                                                offset: os.subtotalOffset || 100
                                            },
                                            tax: {
                                                value: os.taxValue || 0,
                                                offset: os.taxOffset || 100
                                            },
                                            currency: os.currency || 'IDR'
                                        }
                                    })
                                }
                            ]
                        }
                    })
                }
            }
        };
    } else if ('buttonsMessage' in message) {
    const bm = message.buttonsMessage

    let locationMessage

    if (bm.locationMessage) {
        const loc = bm.locationMessage
        const thumbInput = loc.jpegThumbnail || loc.thumbnail

        let thumb
        if (thumbInput) {
            thumb = await processLocationThumbnail(thumbInput)
        }

        locationMessage = WAProto_1.proto.Message.LocationMessage.create({
            degreesLatitude: loc.degreesLatitude || 0,
            degreesLongitude: loc.degreesLongitude || 0,
            name: loc.name || '',
            address: loc.address || '',
            jpegThumbnail: thumb
        })
    }

    const buttons = (bm.buttons || []).map(btn =>
        WAProto_1.proto.Message.ButtonsMessage.Button.create({
            buttonId: btn.buttonId || '',
            buttonText: WAProto_1.proto.Message.ButtonsMessage.Button.ButtonText.create({
                displayText: btn.buttonText?.displayText || ''
            }),
            type: btn.type || 1,
            nativeFlowInfo: btn.nativeFlowInfo
                ? WAProto_1.proto.Message.ButtonsMessage.Button.NativeFlowInfo.create({
                    name: btn.nativeFlowInfo.name || '',
                    paramsJson: btn.nativeFlowInfo.paramsJson || '',
                    buttonParamsJson:
                        btn.nativeFlowInfo.buttonParamsJson ||
                        btn.nativeFlowInfo.paramsJson ||
                        ''
                })
                : undefined
        })
    )

    m = {
        buttonsMessage: WAProto_1.proto.Message.ButtonsMessage.create({
            locationMessage,
            contentText: bm.contentText || '',
            footerText: bm.footerText || '',
            buttons,
            headerType: bm.headerType || 6,
            viewOnce: !!bm.viewOnce
        })
    }
} else if ('stickerPack' in message) {
        const {
            stickers: stickers,
            cover: cover,
            name: name,
            publisher: publisher,
            packId: packId,
            description: description,
        } = message.stickerPack;
        const stickerData = {};
        const stickerPromises = stickers.map(async (s, i) => {
            let buffer;
            if (typeof s.sticker === 'string' && (s.sticker.startsWith('http://') || s.sticker.startsWith('https://'))) {
                const resp = await axios_1.default.get(s.sticker, { responseType: 'arraybuffer' });
                buffer = Buffer.from(resp.data);
            } else if (typeof s.sticker === 'string') {
                buffer = await fs_1.promises.readFile(s.sticker);
            } else if (Buffer.isBuffer(s.sticker)) {
                buffer = s.sticker;
            } else {
                throw new Error('sticker must be URL, path or Buffer');
            }
            const hash = (0, crypto_2.sha256)(buffer).toString('base64url');
            const fileName = `${i.toString().padStart(2, '0')}_${hash}.webp`;
            stickerData[fileName] = [new Uint8Array(buffer), { level: 0 }];
            return {
                fileName: fileName,
                mimetype: 'image/webp',
                isAnimated: s.isAnimated || false,
                isLottie: s.isLottie || false,
                emojis: s.emojis || [],
                accessibilityLabel: s.accessibilityLabel || '',
            };
        });
        const stickerMetadata = await Promise.all(stickerPromises);

        const zipBuffer = await new Promise((resolve, reject) => {
            zip(stickerData, (err, data) => {
                if (err) reject(err);
                else resolve(Buffer.from(data));
            });
        });

        let coverBuffer;
        if (typeof cover === 'string' && (cover.startsWith('http://') || cover.startsWith('https://'))) {
            const resp = await axios_1.default.get(cover, { responseType: 'arraybuffer' });
            coverBuffer = Buffer.from(resp.data);
        } else if (typeof cover === 'string') {
            coverBuffer = await fs_1.promises.readFile(cover);
        } else if (Buffer.isBuffer(cover)) {
            coverBuffer = cover;
        } else {
            throw new Error('cover must be URL, path or Buffer');
        }

        const [stickerPackUpload, coverUpload] = await Promise.all([
            (0, messages_media_1.encryptedStream)(zipBuffer, 'sticker-pack', {
                logger: options.logger,
                opts: options.options,
            }),
            prepareWAMessageMedia(
                { image: coverBuffer },
                { ...options, mediaTypeOverride: 'image' }
            ),
        ]);

        const stickerPackUploadResult = await options.upload(stickerPackUpload.encWriteStream, {
            fileEncSha256B64: stickerPackUpload.fileEncSha256.toString('base64'),
            mediaType: 'sticker-pack',
            timeoutMs: options.mediaUploadTimeoutMs,
        });

        const coverImage = coverUpload.imageMessage;
        const imageDataHash = (0, crypto_2.sha256)(coverBuffer).toString('base64');
        const stickerPackId = packId || (0, generics_1.generateMessageID)();

        m.stickerPackMessage = {
            name: name,
            publisher: publisher,
            stickerPackId: stickerPackId,
            packDescription: description,
            stickerPackOrigin: WAProto_1.proto.Message.StickerPackMessage.StickerPackOrigin.THIRD_PARTY,
            stickerPackSize: stickerPackUpload.fileLength,
            stickers: stickerMetadata,
            fileSha256: stickerPackUpload.fileSha256,
            fileEncSha256: stickerPackUpload.fileEncSha256,
            mediaKey: stickerPackUpload.mediaKey,
            directPath: stickerPackUploadResult.directPath,
            fileLength: stickerPackUpload.fileLength,
            mediaKeyTimestamp: (0, generics_1.unixTimestampSeconds)(),
            trayIconFileName: `${stickerPackId}.png`,
            imageDataHash: imageDataHash,
            thumbnailDirectPath: coverImage.directPath,
            thumbnailFileSha256: coverImage.fileSha256,
            thumbnailFileEncSha256: coverImage.fileEncSha256,
            thumbnailHeight: coverImage.height,
            thumbnailWidth: coverImage.width,
        };
} else if ('richMessage' in message) {
    const rich = message.richMessage;
    const submessages = [];
    const sections = [];
    const richResponseSources = [];

    if (rich.text) {
        let finalText = rich.text;
        finalText = finalText.replace(/\[citation\]\((.+?)\)/g, (match, url) => {
            return `[](\n${url})`;
        });

        const parsed = typeof finalText === 'string' ? extractIE(finalText) : finalText;
        const text = parsed.text || parsed;
        const inline_entities = parsed.ie ? parsed.ie.map(({ type, ie }) => {
            if (type === 'hyperlink') return {
                key: ie.key,
                metadata: {
                    display_name: ie.text,
                    is_trusted: ie.is_trusted,
                    url: ie.url,
                    __typename: 'GenAIInlineLinkItem'
                }
            };
            if (type === 'citation') return {
                key: ie.key,
                metadata: {
                    reference_id: ie.reference_id,
                    reference_url: ie.url,
                    reference_title: ie.url,
                    reference_display_name: ie.url,
                    sources: [],
                    __typename: 'GenAISearchCitationItem'
                }
            };
            if (type === 'latex') return {
                key: ie.key,
                metadata: {
                    latex_expression: ie.text || '',
                    latex_image: {
                        url: ie.url,
                        width: Number(ie.width) || 100,
                        height: Number(ie.height) || 100
                    },
                    font_height: Number(ie.font_height) || 83.33,
                    padding: Number(ie.padding) || 15,
                    __typename: 'GenAILatexItem'
                }
            };
            return null;
        }).filter(Boolean) : [];
        submessages.push({ messageType: 2, messageText: text });
        sections.push(newLayout('Single', {
            text,
            ...(inline_entities.length && { inline_entities }),
            __typename: 'GenAIMarkdownTextUXPrimitive'
        }));
    }

    if (rich.code) {
        const { language, code } = rich.code;
        const tok = tokenizer(code, language);
        submessages.push({ messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks: tok.codeBlock } });
        sections.push(newLayout('Single', { language, code_blocks: tok.unified_codeBlock, __typename: 'GenAICodeUXPrimitive' }));
    }

    if (rich.table) {
        const meta = toTableMetadata(rich.table);
        submessages.push({ messageType: 4, tableMetadata: { title: meta.title, rows: meta.rows } });
        sections.push(newLayout('Single', { rows: meta.unified_rows, __typename: 'GenATableUXPrimitive' }));
    }

    if (rich.image) {
        const url = rich.image;
        submessages.push({
            messageType: 1,
            gridImageMetadata: {
                gridImageUrl: { imagePreviewUrl: url },
                imageUrls: [{ imagePreviewUrl: url, imageHighResUrl: url, sourceUrl: 'https://www.levvicode.cloud/' }]
            }
        });
        sections.push(newLayout('Single', {
            media: { url, mime_type: 'image/jpeg' },
            imagine_type: 3,
            status: { status: 'READY' },
            __typename: 'GenAIImaginePrimitive'
        }));
    }

    if (rich.images) {
        const urls = Array.isArray(rich.images) ? rich.images : [rich.images];
        const imageUrls = urls.map(url => ({
            imagePreviewUrl: url,
            imageHighResUrl: url,
            sourceUrl: 'https://www.levvicode.cloud/'
        }));
        submessages.push({
            messageType: 1,
            gridImageMetadata: {
                gridImageUrl: { imagePreviewUrl: imageUrls[0]?.imagePreviewUrl },
                imageUrls
            }
        });
        imageUrls.forEach(({ imagePreviewUrl }) => {
            sections.push(newLayout('Single', {
                media: { url: imagePreviewUrl, mime_type: 'image/jpeg' },
                imagine_type: 3,
                status: { status: 'READY' },
                __typename: 'GenAIImaginePrimitive'
            }));
        });
    }

    if (rich.video) {
        const url = rich.video;
        sections.push(newLayout('Single', {
            media: { url, mime_type: 'video/mp4', duration: 10 },
            imagine_type: 'ANIMATE',
            status: { status: 'READY' },
            __typename: 'GenAIImaginePrimitive'
        }));
    }

    if (rich.productSingle) {
        const product = rich.productSingle;
        sections.push({
            view_model: {
                primitive: {
                    title: product.title,
                    brand: product.brand,
                    price: product.price,
                    sale_price: product.sale_price,
                    product_url: product.product_url,
                    image: {
                        url: product.image
                    },
                    additional_images: (product.additional_images || [{ url: product.icon || product.image }]),
                    __typename: "GenAIProductItemCardPrimitive"
                },
                __typename: "GenAISingleLayoutViewModel"
            }
        });
    }

    if (rich.productMultiple) {
        const products = rich.productMultiple;
        sections.push({
            view_model: {
                primitives: products.map(item => ({
                    title: item.title,
                    brand: item.brand,
                    price: item.price,
                    sale_price: item.sale_price,
                    product_url: item.product_url,
                    image: {
                        url: item.image
                    },
                    additional_images: item.additional_images || [{ url: item.icon || item.image }],
                    __typename: "GenAIProductItemCardPrimitive"
                })),
                __typename: "GenAIHScrollLayoutViewModel"
            }
        });
    }

    if (rich.post) {
        const posts = Array.isArray(rich.post) ? rich.post : [rich.post];
        sections.push(newLayout("HScroll", posts.map(p => ({
            post_id: p.post_id || randomUUID(),
            source_app: p.source_app || "INSTAGRAM",
            post_type: p.post_type || "IMAGE",
            orientation: p.orientation || "LANDSCAPE",
            title: p.title || "",
            subtitle: p.subtitle || "",
            username: p.username || "",
            is_verified: !!p.is_verified,
            profile_picture_url: p.profile_picture_url || "",
            thumbnail_url: p.thumbnail_url || "",
            post_caption: p.post_caption || "",
            post_url: p.post_url || "https://levvicode.cloud",
            post_deeplink: p.post_deeplink || p.post_url || "https://levvicode.cloud",
            likes_count: p.likes_count || 0,
            comments_count: p.comments_count || 0,
            shares_count: p.shares_count || 0,
            views_count: p.views_count || 0,
            footer_label: p.footer_label || "",
            footer_icon: p.footer_icon || "",
            is_carousel: posts.length > 1,
            __typename: "GenAIPostPrimitive"
        }))));
    }

    if (rich.reels) {
        const items = Array.isArray(rich.reels) ? rich.reels : [rich.reels];
        const reels = items.map(i => ({
            ...i,
            _avatar: i.profileIconUrl || i.profile_url || '',
            _thumbnail: i.thumbnailUrl || i.thumbnail || '',
            _videoUrl: i.videoUrl || i.url || ''
        }));
        submessages.push({
            messageType: 9,
            contentItemsMetadata: {
                contentType: 1,
                itemsMetadata: reels.map(item => ({
                    reelItem: { title: item.title || '', profileIconUrl: item._avatar, thumbnailUrl: item._thumbnail, videoUrl: item._videoUrl }
                }))
            }
        });
        reels.forEach((item, idx) => richResponseSources.push({
            provider: 'LevviCode',
            thumbnailCDNURL: item._thumbnail,
            sourceProviderURL: item._videoUrl,
            sourceQuery: '',
            faviconCDNURL: item._avatar,
            citationNumber: idx + 1,
            sourceTitle: item.title || ''
        }));
        sections.push(newLayout('HScroll', reels.map(item => ({
            reels_url: item._videoUrl,
            thumbnail_url: item._thumbnail,
            creator: item.title || '',
            avatar_url: item._avatar,
            reels_title: item.reels_title || item.title || '',
            likes_count: item.likes_count || 0,
            shares_count: item.shares_count || 0,
            view_count: item.view_count || 0,
            reel_source: item.reel_source || 'IG',
            is_verified: !!(item.is_verified || item.verified),
            __typename: 'GenAIReelPrimitive'
        }))));
    }

    if (rich.sources) {
        const sourceArr = Array.isArray(rich.sources) ? rich.sources : [rich.sources];
        const sourceItems = sourceArr.map(s => {
            if (typeof s === 'object' && !Array.isArray(s)) return s;
            let iconUrl = s[0];
            return {
                source_type: 'THIRD_PARTY',
                source_display_name: s[2] || '',
                source_subtitle: 'AI',
                source_url: s[1] || '',
                favicon: { url: iconUrl, mime_type: 'image/jpeg', width: 16, height: 16 }
            };
        });
        sections.push(newLayout('Single', { sources: sourceItems, __typename: 'GenAISearchResultPrimitive' }));
    }

    if (rich.tip) sections.push(newLayout('Single', { text: rich.tip, __typename: 'GenAIMetadataTextPrimitive' }));

    if (rich.suggestions) {
        const suggest = Array.isArray(rich.suggestions) ? rich.suggestions : [rich.suggestions];
        sections.push(newLayout('ActionRow', suggest.map(text => ({ prompt_text: text, prompt_type: 'SUGGESTED_PROMPT', __typename: 'GenAIFollowUpSuggestionPillPrimitive' }))));
    }

    if (rich.footer) sections.push(newLayout('Single', { text: rich.footer, __typename: 'GenAIMetadataTextPrimitive' }));

    const unifiedData = {
        response_id: randomUUID(),
        sections: await waitAllPromises(sections)
    };

    m = {
        messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            botMetadata: {
                messageDisclaimerText: rich.title || '',
                richResponseSourcesMetadata: { sources: richResponseSources }
            }
        },
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: 1,
                    submessages: await waitAllPromises(submessages),
                    unifiedResponse: { data: Buffer.from(JSON.stringify(unifiedData)).toString('base64') },
                    contextInfo: { forwardingScore: 1, isForwarded: true, forwardedAiBotMessageInfo: { botJid: '0@bot' }, forwardOrigin: 4 }
                }
            }
        }
    };
} else if ('richMessageV2' in message) {
    const rich = message.richMessageV2
    const submessages = []
    const sections = []

    if (rich.text) {
        submessages.push({
            messageType: 2,
            messageText: rich.text
        })

        sections.push({
            view_model: {
                primitive: {
                    text: rich.text,
                    __typename: 'GenAIMarkdownTextUXPrimitive'
                },
                __typename: 'GenAISingleLayoutViewModel'
            }
        })
    }

    if (rich.table) {
        const rows = [
            {
                items: rich.table.headers.map(String),
                isHeading: true
            },
            ...rich.table.rows.map(row => ({
                items: row.map(String)
            }))
        ]

        submessages.push({
            messageType: 4,
            tableMetadata: {
                title: rich.table.title || '',
                rows
            }
        })

        sections.push({
            view_model: {
                primitive: {
                    title: rich.table.title || '',
                    rows,
                    __typename: 'GenAITableUXPrimitive'
                },
                __typename: 'GenAISingleLayoutViewModel'
            }
        })
    }

    if (rich.code) {
        const { codeBlock, unified_codeBlock } = tokenizer(
            rich.code.content,
            rich.code.language
        )

        submessages.push({
            messageType: 5,
            codeMetadata: {
                codeLanguage: rich.code.language,
                codeBlocks: codeBlock
            }
        })

        sections.push({
            view_model: {
                primitive: {
                    language: rich.code.language,
                    code_blocks: unified_codeBlock,
                    __typename: 'GenAICodeUXPrimitive'
                },
                __typename: 'GenAISingleLayoutViewModel'
            }
        })
    }

    m = {
        messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            botMetadata: {
                messageDisclaimerText: rich.disclaimer || '',
                richResponseSourcesMetadata: {
                    sources: []
                }
            }
        },
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: 1,
                    submessages,
                    unifiedResponse: {
                        data: Buffer.from(JSON.stringify({
                            response_id: randomUUID(),
                            sections
                        }))
                    },
                    contextInfo: {
                        forwardingScore: 1,
                        isForwarded: true,
                        forwardedAiBotMessageInfo: {
                            botJid: rich.botJid || '0@bot'
                        },
                        forwardOrigin: 4
                    }
                }
            }
        }
    }
}else {
        m = await prepareWAMessageMedia(message, options);
    }

    if ('buttons' in message && !!message.buttons) {
        const buttonsMessage = {
            buttons: message.buttons.map(b => ({ ...b, type: WAProto_1.proto.Message.ButtonsMessage.Button.Type.RESPONSE }))
        };
        if ('text' in message) {
            buttonsMessage.contentText = message.text;
            buttonsMessage.headerType = ButtonType.EMPTY;
        } else {
            if ('caption' in message) {
                buttonsMessage.contentText = message.caption;
            }
            const type = Object.keys(m)[0].replace('Message', '').toUpperCase();
            buttonsMessage.headerType = ButtonType[type];
            Object.assign(buttonsMessage, m);
        }
        if ('title' in message && !!message.title) {
            buttonsMessage.text = message.title;
            buttonsMessage.headerType = ButtonType.TEXT;
        }
        if ('footer' in message && !!message.footer) {
            buttonsMessage.footerText = message.footer;
        }
        if ('contextInfo' in message && !!message.contextInfo) {
            buttonsMessage.contextInfo = message.contextInfo;
        }
        if ('mentions' in message && !!message.mentions) {
            buttonsMessage.contextInfo = { mentionedJid: message.mentions };
        }
        m = { buttonsMessage };
    } else if ('templateButtons' in message && !!message.templateButtons) {
        const msg = {
            hydratedButtons: message.hasOwnProperty("templateButtons") ? message.templateButtons : message.templateButtons
        };
        if ('text' in message) {
            msg.hydratedContentText = message.text;
        } else {
            if ('caption' in message) {
                msg.hydratedContentText = message.caption;
            }
            Object.assign(msg, m);
        }
        if ('footer' in message && !!message.footer) {
            msg.hydratedFooterText = message.footer;
        }
        m = {
            templateMessage: {
                fourRowTemplate: msg,
                hydratedTemplate: msg
            }
        };
    }
    if ('sections' in message && !!message.sections) {
        const listMessage = {
            sections: message.sections,
            buttonText: message.buttonText,
            title: message.title,
            footerText: message.footer,
            description: message.text,
            listType: WAProto_1.proto.Message.ListMessage.ListType.SINGLE_SELECT
        };
        m = { listMessage };
    }
    if ('interactiveButtons' in message && !!message.interactiveButtons) {
        const interactiveMessage = {
            nativeFlowMessage: Types_1.WAProto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                buttons: message.interactiveButtons,
            })
        };
        if ('text' in message) {
            interactiveMessage.body = {
                text: message.text
            };
        } else if ('caption' in message) {
            interactiveMessage.body = {
                text: message.caption
            };
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: (_j = message === null || message === void 0 ? void 0 : message.media) !== null && _j !== void 0 ? _j : false,
            };
            Object.assign(interactiveMessage.header, m);
        }
        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = {
                text: message.footer
            };
        }
        if ('title' in message && !!message.title) {
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: (_k = message === null || message === void 0 ? void 0 : message.media) !== null && _k !== void 0 ? _k : false,
            };
            Object.assign(interactiveMessage.header, m);
        }
        if ('contextInfo' in message && !!message.contextInfo) {
            interactiveMessage.contextInfo = message.contextInfo;
        }
        if ('mentions' in message && !!message.mentions) {
            interactiveMessage.contextInfo = { mentionedJid: message.mentions };
        }
        m = { interactiveMessage };
    }
    if ('shop' in message && !!message.shop) {
        const interactiveMessage = {
            shopStorefrontMessage: Types_1.WAProto.Message.InteractiveMessage.ShopMessage.fromObject({
                surface: message.shop,
                id: message.id
            })
        };
        if ('text' in message) {
            interactiveMessage.body = {
                text: message.text
            };
        } else if ('caption' in message) {
            interactiveMessage.body = {
                text: message.caption
            };
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: (_l = message === null || message === void 0 ? void 0 : message.media) !== null && _l !== void 0 ? _l : false,
            };
            Object.assign(interactiveMessage.header, m);
        }
        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = {
                text: message.footer
            };
        }
        if ('title' in message && !!message.title) {
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: (_m = message === null || message === void 0 ? void 0 : message.media) !== null && _m !== void 0 ? _m : false,
            };
            Object.assign(interactiveMessage.header, m);
        }
        if ('contextInfo' in message && !!message.contextInfo) {
            interactiveMessage.contextInfo = message.contextInfo;
        }
        if ('mentions' in message && !!message.mentions) {
            interactiveMessage.contextInfo = { mentionedJid: message.mentions };
        }
        m = { interactiveMessage };
    }
    if ('viewOnce' in message && !!message.viewOnce) {
        m = { viewOnceMessage: { message: m } };
    }
    if ('mentions' in message && ((_o = message.mentions) === null || _o === void 0 ? void 0 : _o.length)) {
        const [messageType] = Object.keys(m);
        m[messageType].contextInfo = m[messageType] || {};
        m[messageType].contextInfo.mentionedJid = message.mentions;
    }
    if ('edit' in message) {
        m = {
            protocolMessage: {
                key: message.edit,
                editedMessage: m,
                timestampMs: Date.now(),
                type: Types_1.WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
            }
        };
    }
    if ('contextInfo' in message && !!message.contextInfo) {
        const [messageType] = Object.keys(m);
        m[messageType] = m[messageType] || {};
        m[messageType].contextInfo = message.contextInfo;
    }
    return Types_1.WAProto.Message.fromObject(m);
};

const generateWAMessageFromContent = (jid, message, options) => {
    if (!options.timestamp) {
        options.timestamp = new Date();
    }
    const innerMessage = normalizeMessageContent(message);
    const key = getContentType(innerMessage);
    const timestamp = (0, generics_1.unixTimestampSeconds)(options.timestamp);
    const { quoted, userJid } = options;

    if (quoted && !(0, WABinary_1.isJidNewsletter)(jid)) {
        const participant = quoted.key.fromMe ? userJid : (quoted.participant || quoted.key.participant || quoted.key.remoteJid);
        let quotedMsg = normalizeMessageContent(quoted.message);
        const msgType = getContentType(quotedMsg);
        if (quotedMsg) {
            quotedMsg = WAProto_1.proto.Message.fromObject({ [msgType]: quotedMsg[msgType] });
            const quotedContent = quotedMsg[msgType];
            if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) {
                delete quotedContent.contextInfo;
            }
            const contextInfo = innerMessage[key].contextInfo || {};
            contextInfo.participant = (0, WABinary_1.jidNormalizedUser)(participant);
            contextInfo.stanzaId = quoted.key.id;
            contextInfo.quotedMessage = quotedMsg;
            if (jid !== quoted.key.remoteJid) {
                contextInfo.remoteJid = quoted.key.remoteJid;
            }
            innerMessage[key].contextInfo = contextInfo;
        }
    }

    if (
        !!(options === null || options === void 0 ? void 0 : options.ephemeralExpiration) &&
        key !== 'protocolMessage' &&
        key !== 'ephemeralMessage' &&
        !(0, WABinary_1.isJidNewsletter)(jid)) {
        innerMessage[key].contextInfo = {
            ...(innerMessage[key].contextInfo || {}),
            expiration: options.ephemeralExpiration || Defaults_1.WA_DEFAULT_EPHEMERAL,
        };
    }

    message = Types_1.WAProto.Message.fromObject(message);
    const messageJSON = {
        key: {
            remoteJid: jid,
            fromMe: true,
            id: (options === null || options === void 0 ? void 0 : options.messageId) || (0, generics_1.generateMessageIDV2)(),
        },
        message: message,
        messageTimestamp: timestamp,
        messageStubParameters: [],
        participant: (0, WABinary_1.isJidGroup)(jid) || (0, WABinary_1.isJidStatusBroadcast)(jid) ? userJid : undefined,
        status: Types_1.WAMessageStatus.PENDING
    };
    return Types_1.WAProto.WebMessageInfo.fromObject(messageJSON);
};

const generateWAMessage = async (jid, content, options) => {
    var _a;
    options.logger = (_a = options === null || options === void 0 ? void 0 : options.logger) === null || _a === void 0 ? void 0 : _a.child({ msgId: options.messageId });
    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { newsletter: (0, WABinary_1.isJidNewsletter)(jid), ...options }), options);
};

const getContentType = (content) => {
    if (content) {
        const keys = Object.keys(content);
        const key = keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage');
        return key;
    }
};

const normalizeMessageContent = (content) => {
    if (!content) {
        return undefined;
    }
    for (let i = 0; i < 5; i++) {
        const inner = getFutureProofMessage(content);
        if (!inner) {
            break;
        }
        content = inner.message;
    }
    return content;
    function getFutureProofMessage(message) {
        return ((message === null || message === void 0 ? void 0 : message.ephemeralMessage)
            || (message === null || message === void 0 ? void 0 : message.viewOnceMessage)
            || (message === null || message === void 0 ? void 0 : message.documentWithCaptionMessage)
            || (message === null || message === void 0 ? void 0 : message.viewOnceMessageV2)
            || (message === null || message === void 0 ? void 0 : message.viewOnceMessageV2Extension)
            || (message === null || message === void 0 ? void 0 : message.editedMessage)
            || (message === null || message === void 0 ? void 0 : message.groupMentionedMessage)
            || (message === null || message === void 0 ? void 0 : message.botInvokeMessage)
            || (message === null || message === void 0 ? void 0 : message.lottieStickerMessage)
            || (message === null || message === void 0 ? void 0 : message.eventCoverImage)
            || (message === null || message === void 0 ? void 0 : message.statusMentionMessage)
            || (message === null || message === void 0 ? void 0 : message.pollCreationOptionImageMessage)
            || (message === null || message === void 0 ? void 0 : message.associatedChildMessage)
            || (message === null || message === void 0 ? void 0 : message.groupStatusMentionMessage)
            || (message === null || message === void 0 ? void 0 : message.pollCreationMessageV4)
            || (message === null || message === void 0 ? void 0 : message.pollCreationMessageV5)
            || (message === null || message === void 0 ? void 0 : message.statusAddYours)
            || (message === null || message === void 0 ? void 0 : message.groupStatusMessage)
            || (message === null || message === void 0 ? void 0 : message.limitSharingMessage)
            || (message === null || message === void 0 ? void 0 : message.botTaskMessage)
            || (message === null || message === void 0 ? void 0 : message.questionMessage)
            || (message === null || message === void 0 ? void 0 : message.groupStatusMessageV2)
            || (message === null || message === void 0 ? void 0 : message.botForwardedMessage));
    }
};

const extractMessageContent = (content) => {
    var _a, _b, _c, _d, _e, _f;
    const extractFromTemplateMessage = (msg) => {
        if (msg.imageMessage) {
            return { imageMessage: msg.imageMessage };
        } else if (msg.documentMessage) {
            return { documentMessage: msg.documentMessage };
        } else if (msg.videoMessage) {
            return { videoMessage: msg.videoMessage };
        } else if (msg.locationMessage) {
            return { locationMessage: msg.locationMessage };
        } else {
            return {
                conversation: 'contentText' in msg
                    ? msg.contentText
                    : ('hydratedContentText' in msg ? msg.hydratedContentText : '')
            };
        }
    };
    content = normalizeMessageContent(content);
    if (content === null || content === void 0 ? void 0 : content.buttonsMessage) {
        return extractFromTemplateMessage(content.buttonsMessage);
    }
    if ((_a = content === null || content === void 0 ? void 0 : content.templateMessage) === null || _a === void 0 ? void 0 : _a.hydratedFourRowTemplate) {
        return extractFromTemplateMessage((_b = content === null || content === void 0 ? void 0 : content.templateMessage) === null || _b === void 0 ? void 0 : _b.hydratedFourRowTemplate);
    }
    if ((_c = content === null || content === void 0 ? void 0 : content.templateMessage) === null || _c === void 0 ? void 0 : _c.hydratedTemplate) {
        return extractFromTemplateMessage((_d = content === null || content === void 0 ? void 0 : content.templateMessage) === null || _d === void 0 ? void 0 : _d.hydratedTemplate);
    }
    if ((_e = content === null || content === void 0 ? void 0 : content.templateMessage) === null || _e === void 0 ? void 0 : _e.fourRowTemplate) {
        return extractFromTemplateMessage((_f = content === null || content === void 0 ? void 0 : content.templateMessage) === null || _f === void 0 ? void 0 : _f.fourRowTemplate);
    }
    return content;
};

const getDevice = (id) => /^3A.{18}$/.test(id) ? 'ios' :
    /^3E.{20}$/.test(id) ? 'web' :
        /^(.{21}|.{32})$/.test(id) ? 'android' :
            /^(3F|.{18}$)/.test(id) ? 'desktop' :
                'unknown';

const updateMessageWithReceipt = (msg, receipt) => {
    msg.userReceipt = msg.userReceipt || [];
    const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid);
    if (recp) {
        Object.assign(recp, receipt);
    } else {
        msg.userReceipt.push(receipt);
    }
};

const updateMessageWithReaction = (msg, reaction) => {
    const authorID = (0, generics_1.getKeyAuthor)(reaction.key);
    const reactions = (msg.reactions || [])
        .filter(r => (0, generics_1.getKeyAuthor)(r.key) !== authorID);
    reaction.text = reaction.text || '';
    reactions.push(reaction);
    msg.reactions = reactions;
};

const updateMessageWithPollUpdate = (msg, update) => {
    var _a, _b;
    const authorID = (0, generics_1.getKeyAuthor)(update.pollUpdateMessageKey);
    const reactions = (msg.pollUpdates || [])
        .filter(r => (0, generics_1.getKeyAuthor)(r.pollUpdateMessageKey) !== authorID);
    if ((_b = (_a = update.vote) === null || _a === void 0 ? void 0 : _a.selectedOptions) === null || _b === void 0 ? void 0 : _b.length) {
        reactions.push(update);
    }
    msg.pollUpdates = reactions;
};

function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
    var _a, _b, _c;
    const opts = ((_a = message === null || message === void 0 ? void 0 : message.pollCreationMessage) === null || _a === void 0 ? void 0 : _a.options) || ((_b = message === null || message === void 0 ? void 0 : message.pollCreationMessageV2) === null || _b === void 0 ? void 0 : _b.options) || ((_c = message === null || message === void 0 ? void 0 : message.pollCreationMessageV3) === null || _c === void 0 ? void 0 : _c.options) || [];
    const voteHashMap = opts.reduce((acc, opt) => {
        const hash = (0, crypto_2.sha256)(Buffer.from(opt.optionName || '')).toString();
        acc[hash] = {
            name: opt.optionName || '',
            voters: []
        };
        return acc;
    }, {});
    for (const update of pollUpdates || []) {
        const { vote } = update;
        if (!vote) {
            continue;
        }
        for (const option of vote.selectedOptions || []) {
            const hash = option.toString();
            let data = voteHashMap[hash];
            if (!data) {
                voteHashMap[hash] = {
                    name: 'Unknown',
                    voters: []
                };
                data = voteHashMap[hash];
            }
            voteHashMap[hash].voters.push((0, generics_1.getKeyAuthor)(update.pollUpdateMessageKey, meId));
        }
    }
    return Object.values(voteHashMap);
}

const aggregateMessageKeysNotFromMe = (keys) => {
    const keyMap = {};
    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) {
            const uqKey = `${remoteJid}:${participant || ''}`;
            if (!keyMap[uqKey]) {
                keyMap[uqKey] = {
                    jid: remoteJid,
                    participant: participant,
                    messageIds: []
                };
            }
            keyMap[uqKey].messageIds.push(id);
        }
    }
    return Object.values(keyMap);
};

const REUPLOAD_REQUIRED_STATUS = [410, 404];

const downloadMediaMessage = async (message, type, options, ctx) => {
    const result = await downloadMsg()
        .catch(async (error) => {
            var _a;
            if (ctx) {
                if (axios_1.default.isAxiosError(error)) {
                    if (REUPLOAD_REQUIRED_STATUS.includes((_a = error.response) === null || _a === void 0 ? void 0 : _a.status)) {
                        ctx.logger.info({ key: message.key }, 'sending reupload media request...');
                        message = await ctx.reuploadRequest(message);
                        const result = await downloadMsg();
                        return result;
                    }
                }
            }
            throw error;
        });
    return result;
    async function downloadMsg() {
        const mContent = extractMessageContent(message.message);
        if (!mContent) {
            throw new boom_1.Boom('No message present', { statusCode: 400, data: message });
        }
        const contentType = getContentType(mContent);
        let mediaType = contentType === null || contentType === void 0 ? void 0 : contentType.replace('Message', '');
        const media = mContent[contentType];
        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
            throw new boom_1.Boom(`"${contentType}" message is not a media message`);
        }
        let download;
        if ('thumbnailDirectPath' in media && !('url' in media)) {
            download = {
                directPath: media.thumbnailDirectPath,
                mediaKey: media.mediaKey
            };
            mediaType = 'thumbnail-link';
        } else {
            download = media;
        }
        const stream = await (0, messages_media_1.downloadContentFromMessage)(download, mediaType, options);
        if (type === 'buffer') {
            const bufferArray = [];
            for await (const chunk of stream) {
                bufferArray.push(chunk);
            }
            return Buffer.concat(bufferArray);
        }
        return stream;
    }
};

const assertMediaContent = (content) => {
    content = extractMessageContent(content);
    const mediaContent = (content === null || content === void 0 ? void 0 : content.documentMessage)
        || (content === null || content === void 0 ? void 0 : content.imageMessage)
        || (content === null || content === void 0 ? void 0 : content.videoMessage)
        || (content === null || content === void 0 ? void 0 : content.audioMessage)
        || (content === null || content === void 0 ? void 0 : content.stickerMessage);
    if (!mediaContent) {
        throw new boom_1.Boom('given message is not a media message', { statusCode: 400, data: content });
    }
    return mediaContent;
};

const toJid = (id) => {
    if (!id) return '';
    if (id.endsWith('@lid')) return id.replace('@lid', '@s.whatsapp.net');
    if (id.includes('@')) return id;
    return `${id}@s.whatsapp.net`;
};

const getSenderLid = (message) => {
    const sender = message.key.participant || message.key.remoteJid;
    const user = (0, WABinary_1.jidDecode)(sender)?.user || '';
    const lid = (0, WABinary_1.jidEncode)(user, 'lid');
    console.log('sender lid:', lid);
    return { jid: sender, lid };
};

exports.extractUrlFromText = extractUrlFromText;
exports.generateLinkPreviewIfRequired = generateLinkPreviewIfRequired;
exports.prepareWAMessageMedia = prepareWAMessageMedia;
exports.prepareDisappearingMessageSettingContent = prepareDisappearingMessageSettingContent;
exports.generateForwardMessageContent = generateForwardMessageContent;
exports.generateWAMessageContent = generateWAMessageContent;
exports.generateWAMessageFromContent = generateWAMessageFromContent;
exports.generateWAMessage = generateWAMessage;
exports.getContentType = getContentType;
exports.normalizeMessageContent = normalizeMessageContent;
exports.extractMessageContent = extractMessageContent;
exports.getDevice = getDevice;
exports.updateMessageWithReceipt = updateMessageWithReceipt;
exports.updateMessageWithReaction = updateMessageWithReaction;
exports.updateMessageWithPollUpdate = updateMessageWithPollUpdate;
exports.getAggregateVotesInPollMessage = getAggregateVotesInPollMessage;
exports.aggregateMessageKeysNotFromMe = aggregateMessageKeysNotFromMe;
exports.downloadMediaMessage = downloadMediaMessage;
exports.assertMediaContent = assertMediaContent;
exports.toJid = toJid;
exports.getSenderLid = getSenderLid;
exports.prepareAlbumMessageContent = prepareAlbumMessageContent;
exports.processLocationThumbnail = processLocationThumbnail;