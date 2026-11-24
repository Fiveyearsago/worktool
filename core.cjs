function validateIcon(icon) {
  if (icon == null) return;
  if (typeof icon !== 'object' || Array.isArray(icon) || typeof icon.name !== 'string' || icon.name.length > 300 || !/^attachments\/[a-f0-9-]+\.png$/.test(icon.path) || Object.keys(icon).some(k => !['path', 'name'].includes(k))) throw Error('应用 Icon 格式无效');
}
const {validateKnowledgeConfig}=require('./knowledge-config.cjs');
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {execFileSync}=require('node:child_process');
const {isIP}=require('node:net');
function cleanVpsIp(value=''){if(typeof value!=='string'||value.length>64)throw Error('跳板机 VPS IP 地址格式无效');const ip=value.trim();if(ip&&!isIP(ip))throw Error('请填写有效的跳板机 VPS IP 地址（IPv4 或 IPv6，不含端口）');return ip;}
const seed=()=>({revision:0,knowledge:{repo:''},projects:[{id:'demo',name:'示例项目 · 充电工具',description:'仅为演示数据，可以修改或删除。',repo:'https://example.com/team/demo.git'}],packages:[{id:'demo-app',projectId:'demo',name:'演示应用',applicationId:'com.example.demo',branch:'main',flavor:'demo',vpsIp:'',notes:'同分支不同 flavor，或不同分支均可。',tasks:[{id:'task-domain',title:'配置域名',done:false,content:'',notes:'填写已确认的域名，或关联说明文件。',files:[]}]}],accounts:[],templates:[{id:'new-app',name:'新包准备清单',steps:['确定包名','确定应用名','准备 icon','配置域名','广告配置','Adjust 配置','Firebase 配置'].map((title,i)=>({id:'step-'+i,title}))}],docs:[{id:'welcome',projectId:'demo',title:'项目使用说明',content:'# 欢迎使用 WorkTool\n\n这是独立示例工作区。项目、应用包、模板及资料保存在 hub.json。\n\n请勿将密码、私钥、签名文件或敏感配置放进同步工作区。'}]});
function validate(s){validateKnowledgeConfig(s?.knowledge);if(!s||!Number.isSafeInteger(s.revision)||s.revision<0)throw Error('数据版本无效');for(const k of ['projects','packages','accounts','templates','docs']){if(!Array.isArray(s[k])||s[k].length>10000)throw Error('数据结构无效：'+k);const ids=new Set();for(const x of s[k]){if(!x||typeof x.id!=='string'||!x.id||ids.has(x.id))throw Error('重复或无效 ID');ids.add(x.id);}}const p=new Set(s.projects.map(x=>x.id)),a=new Set(s.accounts.map(x=>x.id));for(const x of s.packages){validateIcon(x.icon);if(!p.has(x.projectId))throw Error('应用包所属项目不存在');if(x.gpAccountId&&!a.has(x.gpAccountId))throw Error('GP 账号不存在');if(x.vpsIp!==undefined)cleanVpsIp(x.vpsIp);if(!Array.isArray(x.tasks))throw Error('待办格式无效');}for(const d of s.docs)if(d.projectId&&!p.has(d.projectId))throw Error('文档所属项目不存在');if(JSON.stringify(s).length>10000000)throw Error('数据超过 10 MB 限制');return s;}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function withWorkspaceLock(dir,fn){
 const lock=path.join(require('node:os').tmpdir(),'worktool-'+hash(fs.realpathSync(dir))+'.lock');
 let fd;try{fd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('工作区正在写入，请稍后重试；异常退出后请确认无运行实例再处理锁文件');throw e;}
 try{return fn();}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
class Store{
 constructor(dir){this.dir=dir;this.file=path.join(dir,'hub.json');fs.mkdirSync(dir,{recursive:true});withWorkspaceLock(dir,()=>{if(!fs.existsSync(this.file)){const entries=fs.readdirSync(dir).filter(x=>x!=='.git');if(entries.length)throw Error('请选择空目录或已有 WorkTool 工作区');this.atomic(seed());}});this.load();}
 atomic(s){
  const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';let fd;
  try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(s,null,2),'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,this.file);}
  finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 }
 load(){if(fs.lstatSync(this.file).isSymbolicLink())throw Error('不允许符号链接');const bytes=fs.readFileSync(this.file);const s=validate(JSON.parse(bytes));s.__baseHash=hash(bytes);return s;}
 save(s){return withWorkspaceLock(this.dir,()=>{
  validate(s);const old=this.load();if(s.revision!==old.revision||s.__baseHash!==old.__baseHash)throw Error('数据已更新，请重新加载后再保存');
  const backups=path.join(this.dir,'.backups');try{fs.mkdirSync(backups,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const stat=fs.lstatSync(backups);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('备份目录不允许符号链接');
  fs.copyFileSync(this.file,path.join(backups,Date.now()+'-'+crypto.randomUUID()+'.json'),fs.constants.COPYFILE_EXCL);
  const next={...s,revision:s.revision+1};delete next.__baseHash;delete next.__knowledge;delete next.__icons;validate(next);this.atomic(next);const saved=this.load();Object.assign(s,saved);return saved;
 });}
 importFile(src){const ext=path.extname(src).toLowerCase();if(!['.md','.txt','.pdf','.png','.jpg','.jpeg','.webp','.csv'].includes(ext))throw Error('仅支持说明文档和图片，禁止导入密钥/可执行文件');if(fs.statSync(src).size>20*1024*1024)throw Error('文件超过 20 MB');const name=path.basename(src),relative='attachments/'+crypto.randomUUID()+ext;fs.mkdirSync(path.join(this.dir,'attachments'),{recursive:true});if(fs.lstatSync(path.join(this.dir,'attachments')).isSymbolicLink())throw Error('不允许符号链接');fs.copyFileSync(src,path.join(this.dir,relative));return {path:relative,name};}resolveFile(p){if(typeof p!=='string'||!/^attachments\/[a-f0-9-]+\.[a-z]+$/.test(p))throw Error('不允许打开此路径');const resolved=path.resolve(this.dir,p);if(fs.lstatSync(path.join(this.dir,'attachments')).isSymbolicLink()||fs.lstatSync(resolved).isSymbolicLink())throw Error('不允许符号链接');return resolved;}}
// Finder-launched macOS apps may inherit a broken Intel Git earlier in PATH.
// Prefer Apple's compatible binary without changing the machine's environment.
const gitExecutable=process.platform==='darwin'?'/usr/bin/git':'git';
function git(dir,args){return execFileSync(gitExecutable,['-c','core.hooksPath=/dev/null',...args],{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'},maxBuffer:1024*1024}).trim();}
function gitStatus(dir){try{if(fs.realpathSync(git(dir,['rev-parse','--show-toplevel']))!==fs.realpathSync(dir))return {output:'工作区不是独立 Git 仓库。请先在该目录初始化 Git。'};return {output:git(dir,['status','--short','--branch'])||'工作区干净'};}catch{return {output:'尚未初始化 Git。数据已本地保存，但尚未远端备份。'};}}
function syncPlan(dir){
 if(fs.realpathSync(git(dir,['rev-parse','--show-toplevel']))!==fs.realpathSync(dir))throw Error('只允许同步独立工作区仓库');
 if(git(dir,['status','--porcelain','--untracked-files=all']))throw Error('有未提交修改。请先在 Git 工具中审核、提交后再同步。');
 if(git(dir,['ls-files','--','.backups']))throw Error('禁止同步已跟踪的备份');
 validate(JSON.parse(fs.readFileSync(path.join(dir,'hub.json'),'utf8')));
 const branch=git(dir,['symbolic-ref','--short','HEAD']);
 const remote=git(dir,['config','--get-all','branch.'+branch+'.remote']);
 const ref=git(dir,['config','--get-all','branch.'+branch+'.merge']);
 if(!remote||remote==='.'||remote.includes('\n')||remote.startsWith('-')||!ref.startsWith('refs/heads/')||ref.includes('\n'))throw Error('需要单一有效远端 upstream 分支');
 git(dir,['check-ref-format',ref]);
 const fetchUrl=git(dir,['remote','get-url','--all',remote]);const pushUrl=git(dir,['remote','get-url','--push','--all',remote]);
 if([fetchUrl,pushUrl].some(u=>!u||u.includes('\n')||u.startsWith('-')))throw Error('需要单一有效远端 URL');
 return {branch,remote,ref,fetchUrl,pushUrl,head:git(dir,['rev-parse','HEAD'])};
}
function gitSync(dir,approved){return withWorkspaceLock(dir,()=>{
 const plan=syncPlan(dir);if(approved&&JSON.stringify(plan)!==JSON.stringify(approved))throw Error('同步目标或内容已改变，请重新确认');
 git(dir,['fetch','--no-tags','--no-recurse-submodules',plan.fetchUrl,plan.ref]);
 const incoming=git(dir,['rev-parse','FETCH_HEAD']);
 if(git(dir,['ls-tree','-r','--name-only',incoming,'--','.backups']))throw Error('远端包含已跟踪的备份，停止同步');
 const entry=git(dir,['ls-tree',incoming,'--','hub.json']);if(!/^100644 blob |^100755 blob /.test(entry))throw Error('远端 hub.json 必须是普通文件');
 validate(JSON.parse(git(dir,['show',incoming+':hub.json'])));
 const counts=git(dir,['rev-list','--left-right','--count','HEAD...'+incoming]).split(/\s+/).map(Number);
 if(counts[0]&&counts[1])throw Error('本地与远端已分叉，请在 Git 工具中处理；不会覆盖数据。');
 if(JSON.stringify(syncPlan(dir))!==JSON.stringify(plan))throw Error('同步期间工作区已改变，停止同步');
 if(counts[1])git(dir,['merge','--ff-only',incoming]);
 git(dir,['-c','push.followTags=false','-c','push.gpgSign=false','push','--no-follow-tags','--no-force','--no-recurse-submodules',plan.pushUrl,'HEAD:'+plan.ref]);
 return {output:'同步成功：已检查远端并推送。请重新加载最新数据。'};
});}
module.exports={validateIcon,Store,seed,validate,cleanVpsIp,gitStatus,gitSync,gitExecutable,syncPlan};
