'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const {parseText,findSecrets}=require('./import-parser.cjs');
const {cleanVpsIp}=require('./core.cjs');
const {knowledgeURL}=require('./knowledge-config.cjs');
const MAX_TEXT=1024*1024, MAX_FILE=20*1024*1024;
const extensions=['md','markdown','txt','csv','png','jpg','jpeg','webp','docx'];
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const normalize=x=>String(x||'').trim().toLowerCase();
function clean(value,max=2000){if(typeof value!=='string'||value.length>max)throw Error('导入字段过长或格式无效');return value.trim();}
function checkSecrets(text){const found=findSecrets(text);if(found.length)throw Error('检测到可能的敏感凭据（'+found.join('、')+'）。请先移除这些内容，再导入；检测只覆盖常见凭据，仍需核对原文件。');}
function decodeText(bytes){let text;if(bytes[0]===0xff&&bytes[1]===0xfe)text=bytes.subarray(2).toString('utf16le');else {try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('文本需为 UTF-8 或 UTF-16LE 编码，请另存为 UTF-8 后导入');}}if(text.includes('\0'))throw Error('不是可识别的文本文件');return text.replace(/^\uFEFF/,'');}
class ImportService {
 constructor(getStore,{nativeExecutable=path.join(__dirname,'native','worktool-extract'),platform=process.platform,aiClient,prepareImages}={}){this.getStore=getStore;this.nativeExecutable=nativeExecutable;this.platform=platform;this.aiClient=aiClient;this.prepareImages=prepareImages;this.sessions=new Map();}
 expire(){for(const [id,s] of this.sessions)if(Date.now()-s.created>30*60*1000)this.sessions.delete(id);}
 discard(token){this.sessions.delete(token);}
 preview(text,source,extracted,context){if(Buffer.byteLength(text)>MAX_TEXT)throw Error('识别文字超过 1 MB，请拆分导入');checkSecrets(text);if(!text.trim())throw Error('没有识别到文字，请换清晰图片或粘贴文字');this.expire();if(this.sessions.size>=5)throw Error('待确认导入过多，请先取消或完成已有预览');const store=this.getStore(),state=store.load();if(context&&(context.store!==store||context.baseHash!==state.__baseHash))throw Error('工作区已切换或更新，请重新导入');const token=crypto.randomUUID(),sourceDigest=digest(source.bytes||text);if(state.docs.some(d=>d.sourceDigest===sourceDigest))throw Error('这份资料已导入，请在知识文档中查看；不会重复创建或覆盖');const parsed=extracted||parseText(text,{ocr:!!source.ocr});checkSecrets(JSON.stringify({project:parsed.project,records:parsed.records}));const session={token,store,baseHash:state.__baseHash,created:Date.now(),text,source,sourceDigest,parseVersion:0};this.sessions.set(token,session);return {token,text,name:source.name,project:parsed.project||{name:parsed.records[0]?.projectName||'',description:'',repo:parsed.records[0]?.repo||''},records:parsed.records,warnings:[...parsed.warnings,...(source.warnings||[])],sourceDigest,mode:source.ai?'longcat':'local',model:parsed.model,elapsedMs:parsed.elapsedMs};}
 context(){const store=this.getStore();return {store,baseHash:store.load().__baseHash};}
 async extractAI(text,images,signal){if(!this.aiClient)throw Error('请先配置 LongCat。');if(text!==undefined){if(typeof text!=='string'||Buffer.byteLength(text)>MAX_TEXT)throw Error('文字超过 1 MB');checkSecrets(text);if(!text.trim())throw Error('请填写文字');}signal?.throwIfAborted();const result=await this.aiClient.extract({text,images,signal});signal?.throwIfAborted();checkSecrets(JSON.stringify({project:result.project,records:result.records}));return result;}
 async fromFile(file,{mode='local',signal}={}){if(!['local','longcat'].includes(mode))throw Error('识别方式无效');const initialStore=this.getStore(),context=this.context();const ext=path.extname(file).slice(1).toLowerCase();if(!extensions.includes(ext))throw Error('暂不支持此格式，请使用 MD、TXT、CSV、DOCX 或截图');const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('请选择普通文件');if(stat.size>MAX_FILE)throw Error('文件超过 20 MB，请拆分后导入');const bytes=fs.readFileSync(file);if(initialStore.load().docs.some(d=>d.sourceDigest===digest(bytes)))throw Error('这份资料已导入，请在知识文档中查看；不会重复创建或覆盖');let text,warnings=[],ocr=false,extracted;
  if(['md','markdown','txt','csv'].includes(ext)){text=decodeText(bytes);}
  else if(mode==='longcat'&&ext!=='docx'){if(!this.prepareImages)throw Error('缺少图片读取组件');const prepared=await this.prepareImages(bytes);warnings.push(...prepared.warnings);extracted=await this.extractAI(undefined,prepared.images,signal);text=extracted.text;}
  else {if(this.platform!=='darwin')throw Error('此版本仅在 Mac 支持图片、DOCX 本地识别。Windows 请使用 AI 识别截图，或先导出 MD/TXT/CSV 再导入');
   if(ext==='docx'){({stdout:text}=await run('/usr/bin/textutil',['-convert','txt','-stdout',file],{encoding:'utf8',timeout:90000,maxBuffer:MAX_TEXT+1024}));warnings.push('Word 格式和表格布局可能丢失，请核对原文。');}
   else {ocr=true;if(!fs.existsSync(this.nativeExecutable))throw Error('缺少本地识别组件，请重新构建客户端');({stdout:text}=await run(this.nativeExecutable,[file],{encoding:'utf8',timeout:90000,maxBuffer:MAX_TEXT+1024}));warnings.push('截图的文字顺序和字符可能识别有误，请重点核对包名、域名与配置 ID。');}
  }
  if(mode==='longcat'&&!extracted)extracted=await this.extractAI(text,undefined,signal);
  if(mode==='longcat')warnings.push('LongCat AI 提取结果，请重点核对包名、域名、配置 ID 和表格对应关系；缺失内容请手动补充。');
  // Verify the exact selected bytes did not change during native extraction.
  if(digest(fs.readFileSync(file))!==digest(bytes))throw Error('源文件在识别期间发生变化，请重新选择');
  if(this.getStore()!==initialStore)throw Error('工作区已切换，请重新导入');
  return this.preview(text,{name:path.basename(file),ext,bytes,warnings,ocr,ai:mode==='longcat'},extracted,context);
 }
 async fromImage(bytes,{signal}={}){
  if(!Buffer.isBuffer(bytes)||!bytes.length)throw Error('剪贴板中没有图片，请先复制截图');
  if(bytes.length>MAX_FILE)throw Error('图片超过 20 MB，请裁剪后重试');
  const context=this.context();
  if(context.store.load().docs.some(d=>d.sourceDigest===digest(bytes)))throw Error('这份资料已导入，请在知识文档中查看；不会重复创建或覆盖');
  const prepared=await this.prepareImages(bytes),result=await this.extractAI(undefined,prepared.images,signal);
  return this.preview(result.text,{name:'项目截图.png',ext:'png',bytes,ai:true,warnings:[...prepared.warnings,'LongCat AI 提取结果，请核对项目与应用信息后保存。']},result,context);
 }
 fromText(text,{mode='local',signal}={}){if(typeof text!=='string')throw Error('请粘贴文本');if(!['local','longcat'].includes(mode))throw Error('识别方式无效');if(mode==='longcat'){const context=this.context();if(context.store.load().docs.some(d=>d.sourceDigest===digest(text)))throw Error('这份资料已导入，请在知识文档中查看；不会重复创建或覆盖');return this.extractAI(text,undefined,signal).then(result=>this.preview(text,{name:'粘贴的项目资料.md',ext:'md',ai:true,warnings:['LongCat AI 提取结果，请核对字段后保存。']},result,context));}return this.preview(text,{name:'粘贴的项目资料.md',ext:'md'});}
 updateText(token,text){const s=this.session(token);if(typeof text!=='string'||Buffer.byteLength(text)>MAX_TEXT)throw Error('文字超过 1 MB');checkSecrets(text);if(!text.trim())throw Error('请填写文字');s.parseVersion++;s.text=text;if(!s.source.bytes)s.sourceDigest=digest(text);}
 async reparseAI(token,text,{signal}={}){const s=this.session(token),version=++s.parseVersion;const parsed=await this.extractAI(text,undefined,signal);if(this.session(token)!==s||s.parseVersion!==version)throw Error('预览已更新，请重新解析');this.updateText(token,text);return {...parsed,warnings:[...parsed.warnings,...(s.source.warnings||[])]};}
 reparse(token,text){const s=this.session(token);if(typeof text!=='string'||Buffer.byteLength(text)>MAX_TEXT)throw Error('文字超过 1 MB');checkSecrets(text);if(!text.trim())throw Error('请填写文字');const parsed=parseText(text,{ocr:!!s.source.ocr});s.text=text;if(!s.source.bytes)s.sourceDigest=digest(text);return {...parsed,warnings:[...parsed.warnings,...(s.source.warnings||[])]};}
 session(token){this.expire();const s=this.sessions.get(token);if(!s)throw Error('预览已过期或已保存，请重新导入');if(s.store!==this.getStore())throw Error('工作区已切换，请重新导入');return s;}
 commit(token,input){const session=this.session(token),store=session.store,state=store.load();if(state.__baseHash!==session.baseHash)throw Error('工作区已更新，请取消并重新导入，避免覆盖修改');if(!input||!Array.isArray(input.records)||input.records.length>100)throw Error('导入记录无效');checkSecrets(JSON.stringify(input));for(const r of input.records){for(const v of Object.values(r))if(typeof v==='string')checkSecrets(v);for(const f of r.fields||[])checkSecrets(String(f.title)+': '+String(f.content));}checkSecrets(session.text);if(state.docs.some(d=>d.sourceDigest===session.sourceDigest))throw Error('这份资料已导入，不会重复保存');if(input.knowledgeRepo!==undefined)state.knowledge={repo:knowledgeURL(input.knowledgeRepo)};const title=clean(input.title,300);if(!title)throw Error('请填写文档标题');const projectId=clean(input.projectId||'',100);let project=state.projects.find(p=>p.id===projectId);if(projectId&&!project)throw Error('所选项目不存在');if(!project){const name=clean(input.projectName||'',300);if(!name)throw Error('请选择项目或填写新项目名称');const same=state.projects.filter(p=>normalize(p.name)===normalize(name));if(same.length)throw Error('已有同名项目，请选择已有项目，不会自动合并');project={id:crypto.randomUUID(),name,description:clean(input.projectDescription||'',20000),repo:clean(input.projectRepo||'',2000)};state.projects.push(project);}
  const names=new Set(state.packages.map(p=>normalize(p.applicationId)));let added=0;
  for(const r of input.records){if(!r.selected)continue;const applicationId=clean(r.applicationId,300),name=clean(r.name,300);if(!name||!applicationId)throw Error('所选应用必须填写应用名与包名；也可以取消勾选，仅保存文档');if(!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(applicationId))throw Error('包名格式无效：'+applicationId);if(names.has(normalize(applicationId)))throw Error('包名已存在或重复：'+applicationId+'。请取消该行，不会覆盖已有产品');names.add(normalize(applicationId));const vpsIp=cleanVpsIp(r.vpsIp);
   if(!Array.isArray(r.fields)||r.fields.length>200)throw Error('配置项无效或过多');const tasks=r.fields.map(f=>({id:crypto.randomUUID(),title:clean(f.title,300),content:clean(f.content,20000),done:false,notes:'从资料导入，请核对后标记完成。',files:[]})).filter(f=>f.title||f.content);if(tasks.some(f=>!f.title))throw Error('请填写配置项名称');state.packages.push({id:crypto.randomUUID(),projectId:project.id,name,applicationId,branch:clean(r.branch||'',500),flavor:clean(r.flavor||'',500),vpsIp,notes:clean(r.notes||'',20000),tasks});added++;
  }
  if(input.records.some(r=>r.selected)&&!added)throw Error('没有有效的应用记录');
  const attachmentDir=path.join(store.dir,'attachments');fs.mkdirSync(attachmentDir,{recursive:true});if(fs.lstatSync(attachmentDir).isSymbolicLink())throw Error('不允许符号链接');const relative='attachments/'+crypto.randomUUID()+'.'+(session.source.ext==='markdown'?'md':session.source.ext);const attachment=path.join(store.dir,relative);
  try{fs.writeFileSync(attachment,session.source.bytes||session.text,{flag:'wx',mode:0o600});state.docs.push({id:crypto.randomUUID(),projectId:project.id,title,content:session.text,files:[{name:session.source.name,path:relative}],sourceDigest:session.sourceDigest,importedAt:new Date().toISOString()});const saved=store.save(state);this.sessions.delete(token);return {state:saved,added,projectId:project.id};}catch(error){try{fs.unlinkSync(attachment);}catch{}throw error;}
 }
}
module.exports={ImportService,extensions,decodeText};
