#!/usr/bin/env node
/**
 * lanhu-login.mjs — 普通蓝湖账号一次性登录，保存 playwright storageState 供 scrape 模式复用。
 *
 * 用法：
 *   node lanhu-login.mjs
 *   # 或：LANHU_LOGIN_URL=https://lanhuapp.com/... node lanhu-login.mjs
 *
 * 行为：弹出一个 Chromium 窗口，你在里面手动登录蓝湖；登录完成后回车，
 * 会把 cookie + localStorage 写入 .auth/lanhu-storage-state.json（已被 .gitignore 忽略）。
 * 之后调用 lanhu_fetch_design({ mode:"scrape", storageState:".auth/lanhu-storage-state.json" }) 即可免登录抽取。
 *
 * 需要 playwright：npm i playwright && npx playwright install chromium
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LOGIN_URL = process.env.LANHU_LOGIN_URL || 'https://lanhuapp.com/';
const OUT = process.env.LANHU_STORAGE_STATE || '.auth/lanhu-storage-state.json';

async function main() {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();
  console.log(`请在打开的浏览器中登录蓝湖：${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  console.log('登录完成后，回到此终端按 Enter 保存登录态…');
  await new Promise((r) => process.stdin.once('data', r));
  const state = await context.storageState();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(state, null, 2), 'utf8');
  console.log(`✅ 登录态已保存至 ${OUT}（请勿提交，已被 .gitignore 忽略）`);
  await browser.close();
}

main().catch((e) => {
  console.error('登录失败：', e?.message || e);
  console.error('请确认已安装 playwright：npm i playwright && npx playwright install chromium');
  process.exit(1);
});
