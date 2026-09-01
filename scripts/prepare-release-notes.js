'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');
const GUIDE_FILE = path.join(ROOT, '.github', 'release-guide.md');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function releaseContent(version, changelog, guide) {
  const pattern = new RegExp(`^## ${escapeRegExp(version)} - (.+) \\([0-9]{4}-[0-9]{2}-[0-9]{2}\\)$`, 'm');
  const match = pattern.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md 中找不到 ${version} 的“版本 - 摘要 (日期)”标题`);

  const headingStart = match.index;
  const bodyStart = headingStart + match[0].length;
  const nextHeading = changelog.indexOf('\n## ', bodyStart);
  const changes = changelog.slice(bodyStart, nextHeading < 0 ? changelog.length : nextHeading).trim();
  if (!changes) throw new Error(`CHANGELOG.md 中 ${version} 的更新内容为空`);

  const renderedGuide = guide.replaceAll('{{VERSION}}', version).trim();
  if (!renderedGuide || renderedGuide.includes('{{VERSION}}')) {
    throw new Error('Release 下载说明模板为空或含有未替换的版本占位符');
  }

  return {
    title: `v${version} - ${match[1].trim()}`,
    notes: `## 本次更新\n\n${changes}\n\n${renderedGuide}\n`,
  };
}

function prepareReleaseNotes(version, options = {}) {
  const changelog = fs.readFileSync(options.changelogFile || CHANGELOG_FILE, 'utf8');
  const guide = fs.readFileSync(options.guideFile || GUIDE_FILE, 'utf8');
  const content = releaseContent(version, changelog, guide);
  fs.writeFileSync(options.titleFile || path.join(ROOT, 'release-title.txt'), `${content.title}\n`);
  fs.writeFileSync(options.notesFile || path.join(ROOT, 'release-notes.md'), content.notes);
  return content;
}

if (require.main === module) {
  const version = String(process.argv[2] || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('用法: node scripts/prepare-release-notes.js <version>');
  }
  const result = prepareReleaseNotes(version);
  console.log(`已生成 Release: ${result.title}`);
}

module.exports = { releaseContent, prepareReleaseNotes };
