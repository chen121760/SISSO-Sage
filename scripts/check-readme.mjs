// Keep the public READMEs short, bilingual, and aligned with the actual user
// workflow. Detailed commands and decision policy belong in AI_GUIDE.md and the
// bundled Skill, not in the ordinary-user landing page.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const englishPath = path.join(root, "README.md");
const chinesePath = path.join(root, "README.zh-CN.md");
const english = fs.existsSync(englishPath) ? fs.readFileSync(englishPath, "utf8") : "";
const chinese = fs.existsSync(chinesePath) ? fs.readFileSync(chinesePath, "utf8") : "";
const problems = [];

function ok(label, condition) {
  console.log(`${condition ? "  PASS  " : "  FAIL  "}${label}`);
  if (!condition) problems.push(label);
}

console.log("Public README workflow:");
ok("English README exists", !!english);
ok("Simplified Chinese README exists", !!chinese);
ok("English links to Simplified Chinese", english.includes("[简体中文](README.zh-CN.md)"));
ok("Simplified Chinese links to English", chinese.includes("[English](README.md)"));
ok("both explain how to download the repository", [english, chinese].every((text) => text.includes("git clone")));
ok("both ask the user to provide SISSO output", english.includes("SISSO output") && chinese.includes("SISSO 输出"));
ok("both ask the user to provide feature-extraction code", english.includes("feature-extraction") && chinese.includes("特征提取"));
ok("both hand command execution to the AI assistant", english.includes("AI assistant will run") && chinese.includes("命令由 AI 老师自行执行"));
ok("both state the local privacy boundary", english.includes("does not\nupload your data") && chinese.includes("不会上传你的数据"));

const maxLines = 90;
ok(`English README stays under ${maxLines} lines`, english.split(/\r?\n/).length <= maxLines);
ok(`Simplified Chinese README stays under ${maxLines} lines`, chinese.split(/\r?\n/).length <= maxLines);

console.log(`\n${problems.length
  ? `RESULT: ${problems.length} README PROBLEM(S)`
  : "RESULT: public READMEs are concise and ready for ordinary users"}`);
process.exitCode = problems.length ? 1 : 0;
