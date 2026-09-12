"use strict";

const gradients = [
    { c1: [255, 80, 120], c2: [255, 180, 210] },
    { c1: [140, 90, 255], c2: [90, 200, 255] },
    { c1: [0, 200, 255], c2: [120, 255, 220] },
    { c1: [255, 170, 0], c2: [255, 255, 120] }
];

const version = "2.0.8";

const mottos = [
    "Lightweight and powerful automation.",
    "Fast, reliable, and secure Baileys fork.",
    "Engineered for high-performance bots.",
    "Modern WhatsApp multi-device solution.",
    "Built with precision and efficiency."
];

const g = gradients[Math.floor(Math.random() * gradients.length)];
const motto = mottos[Math.floor(Math.random() * mottos.length)];

const gradient = (text) =>
    text
        .split("")
        .map((ch, i, arr) => {
            const t = i / (arr.length - 1 || 1);
            const r = Math.round(g.c1[0] + (g.c2[0] - g.c1[0]) * t);
            const gg = Math.round(g.c1[1] + (g.c2[1] - g.c1[1]) * t);
            const b = Math.round(g.c1[2] + (g.c2[2] - g.c1[2]) * t);
            return `\x1b[38;2;${r};${gg};${b}m${ch}`;
        })
        .join("") + "\x1b[0m";

const banner = [
    "┌──────────────────────────────────────────────┐",
    "│               RYUUXALYA BAIL                 │",
    "├──────────────────────────────────────────────┤",
    `│  Version   : v${version.padEnd(31)} 	        │`,
    "│  Developer : Ryuusuke          			    │",
    "│  Phone     : +62 831-6657-0663               │",
    "│  Telegram  : t.me/Ryuusuke_offc              │",
    "│  Instagram : @ryuusuke_id                    │",
    "├──────────────────────────────────────────────┤",
    `│  > ${motto.padEnd(41)} │`,
    "└──────────────────────────────────────────────┘"
];

console.log(banner.map(line => gradient(line)).join("\n"));

var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));

var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m)
        if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p))
            __createBinding(exports, m, p);
};

var __importDefault = (this && this.__importDefault) || function(mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};

Object.defineProperty(exports, "__esModule", { value: true });
exports.proto = exports.makeWASocket = void 0;

const WAProto_1 = require("../WAProto");
Object.defineProperty(exports, "proto", {
    enumerable: true,
    get: function() {
        return WAProto_1.proto;
    }
});

const Socket_1 = __importDefault(require("./Socket"));
exports.makeWASocket = Socket_1.default;

__exportStar(require("../WAProto"), exports);
__exportStar(require("./Utils"), exports);
__exportStar(require("./Types"), exports);
__exportStar(require("./Store"), exports);
__exportStar(require("./Defaults"), exports);
__exportStar(require("./WABinary"), exports);
__exportStar(require("./WAM"), exports);
__exportStar(require("./WAUSync"), exports);

exports.default = Socket_1.default;