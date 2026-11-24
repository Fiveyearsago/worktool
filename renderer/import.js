'use strict';
let importDraft=null,importBusy=false,importSaving=false,importGeneration=0,importPasteText='',importMode='local',importRequestId=null;
const importLabels={name:'应用名称',applicationId:'包名 / Application ID',branch:'Git 分支',flavor:'Flavor',vpsIp:'跳板机 VPS IP 地址',notes:'备注'};
function importPage(){
 const intro=head('导入项目资料','截图和文字提取为项目字段 · 先核对，再保存。');
 if(importSaving)return intro+'<div class="card"><h3>正在保存导入结果…</h3><p>请等待完成，保存期间不能取消或切换页面。</p></div>';
 if(importBusy)return intro+`<div class="card"><h3>${(importDraft?.mode||importMode)==='longcat'?'正在使用 LongCat 识别…':'正在本地识别…'}</h3><p>${(importDraft?.mode||importMode)==='longcat'?'资料正在发送到 LongCat，通常需要一些时间，单次请求最长 60 秒。取消后将停止等待结果，已发送的请求可能仍会计费。':'图片可能需要一些时间，请勿重复选择。最长约 90 秒。'}</p>${button('取消本次导入','import-cancel')}</div>`;
 if(!importDraft)return intro+`<div class="card import-drop-zone" id="import-drop-zone" data-import-drop="import" tabindex="0" aria-label="资料拖入与截图粘贴区域"><h3>拖入文件，或粘贴截图</h3><p>把图片或文档拖到此区域；截图可直接按 ⌘V / Ctrl+V 粘贴。一次导入一个文件，识别后核对并创建项目。</p><div class="field"><label for="import-mode">识别方式</label><select id="import-mode"><option value="longcat" ${importMode==='longcat'?'selected':''}>LongCat AI（上传所选资料）</option><option value="local" ${importMode==='local'?'selected':''}>本地识别（离线）</option></select></div><p class="help">LongCat AI 会发送所选截图或文字到 LongCat。请先移除敏感内容。</p><div class="actions"><button class="btn small" data-page="ai">配置 LongCat API Key</button></div><p>支持 Markdown（.md）、TXT、CSV、复制的表格。图片支持 PNG、JPG、JPEG、WebP，LongCat AI 可直接识别图片中的文字和表格；Mac 也支持本地截图识别和 DOCX 文字提取。本版本暂不直接读取 Excel，请另存为 CSV。</p><div class="actions">${button('选择图片或文档','import-file','','primary')}${button('粘贴截图识别','import-clipboard')}</div><p class="help">文件不超过 20 MB，识别文字不超过 1 MB。请移除密码、私钥等秘密，原文件将在确认后复制到工作区，可能随你的 Git 提交同步。</p><div class="field"><label for="import-paste">或直接粘贴钉钉表格 / Markdown / 配置文字</label><textarea id="import-paste" placeholder="应用名：示例应用&#10;包名：com.example.app&#10;分支：main&#10;域名：https://example.com">${e(importPasteText)}</textarea></div>${button('解析粘贴内容','import-paste','','primary')}</div>`;
 const d=importDraft;
 return intro+`<div class="import-banner"><strong>导入预览：${e(d.name)}</strong>${d.mode==='longcat'?`<p>LongCat AI · ${e(d.model)} · ${((d.elapsedMs||0)/1000).toFixed(1)} 秒</p>`:''}<p>本次所有勾选的应用统一保存到下方所选项目，请将不同项目分批导入。只新增，不覆盖已有产品。文本原文保存为项目文档；截图保存 AI / OCR 转写文字，原始文件独立保留。应用名和包名缺失时需补充，或取消勾选，仅保存文档。</p>${d.warnings.map(w=>`<p>• ${e(w)}</p>`).join('')}</div><div class="card">${select('import-project','保存到项目',state.projects,d.projectId,'新建项目（在下方填写名称）')}${field('import-project-name','新项目名称',d.projectName)}${field('import-project-description','新项目说明',d.projectDescription||'','textarea')}${field('import-knowledge-repo','项目知识库 Git 仓库地址',d.knowledgeRepo||'','text','所有项目共用此仓库，按项目分目录保存；不会把截图中的代码仓库自动用作知识库。')}${field('import-title','项目文档标题',d.title)}<p class="help">选择已有项目时保留已有项目资料；新项目的信息已从截图提取，可核对修改。跳板机 VPS IP 可留空，填写时请使用 IPv4 或 IPv6 地址；配置内容保存为未完成的任务，等待你核对。</p></div><div class="section-head"><h2>识别到 ${d.records.length} 个应用候选</h2>${button('＋ 手动补一条','import-add')}</div>${d.records.map((r,i)=>{
 const duplicate=state.packages.some(p=>p.applicationId.toLowerCase()===r.applicationId.toLowerCase());
 return `<section class="card import-record" data-import-row="${i}"><div class="row"><input type="checkbox" data-import-select="${i}" aria-label="导入第 ${i+1} 个应用" ${r.selected?'checked':''}><h3 style="margin:0">${i+1}. ${e(r.name||'待确认的应用')}</h3>${r.projectName?`<span class="badge">原文项目：${e(r.projectName)}</span>`:''}${duplicate?'<span class="error">包名已存在，请取消此行；不会覆盖。</span>':''}</div><div class="import-grid">${Object.entries(importLabels).map(([key,label])=>`<div class="field"><label for="import-${i}-${key}">${label}</label>${key==='notes'?`<textarea id="import-${i}-${key}" data-import-key="${key}">${e(r[key]||'')}</textarea>`:`<input id="import-${i}-${key}" data-import-key="${key}" value="${e(r[key]||'')}">`}</div>`).join('')}</div><details><summary>配置项（${r.fields.length} 项，可编辑）</summary><div class="import-fields">${r.fields.map((f,j)=>`<div class="import-config" data-import-config="${j}"><div class="field"><label>配置项名称</label><input aria-label="配置项名称" data-config-title value="${e(f.title)}"></div><div class="field"><label>配置内容</label><textarea aria-label="配置内容" data-config-content>${e(f.content)}</textarea></div>${button('移除此项','import-remove-field',`data-row="${i}" data-index="${j}"`,'small danger')}</div>`).join('')}</div>${button('＋ 添加配置项','import-add-field',`data-row="${i}"`,'small')}</details></section>`;
 }).join('')}<div class="card"><details><summary>识别原文 / Markdown（可修改并重新解析）</summary><div class="field"><textarea id="import-source" aria-label="识别原文">${e(d.text)}</textarea></div>${button('用修改后的原文重新解析','import-reparse')}<p class="help">重新解析将替换上方候选项的修改。原文件仍按原样保留，Markdown 正文保存为此处的确认文本。</p></details><label class="import-ack"><input id="import-confirm" type="checkbox" ${d.confirmed?'checked':''}> 我已核对内容，确认没有密码、私钥或不应进入此工作区的资料。</label><div class="actions">${button('取消导入','import-cancel')}${button('确认并保存到项目','import-save','','primary')}</div><p class="help">原文件保留在工作区附件中。仅本地保存，不会自动提交或推送 Git。</p></div>`;
}
function captureImport(){if(importSaving||importBusy||page!=='import')return;if(!importDraft){importPasteText=$('#import-paste')?.value??importPasteText;return;}const d=importDraft;d.projectId=$('[name="import-project"]')?.value||'';d.projectName=$('[name="import-project-name"]')?.value||'';d.projectDescription=$('[name="import-project-description"]')?.value||'';d.knowledgeRepo=$('[name="import-knowledge-repo"]')?.value||'';d.title=$('[name="import-title"]')?.value||'';d.text=$('#import-source')?.value??d.text;d.confirmed=$('#import-confirm')?.checked||false;document.querySelectorAll('[data-import-row]').forEach(el=>{const r=d.records[Number(el.dataset.importRow)];r.selected=$('[data-import-select]',el).checked;el.querySelectorAll('[data-import-key]').forEach(input=>r[input.dataset.importKey]=input.value);el.querySelectorAll('[data-import-config]').forEach(f=>{r.fields[Number(f.dataset.importConfig)]={title:$('[data-config-title]',f).value,content:$('[data-config-content]',f).value}});});}
async function cancelImport(){if(importSaving)throw Error('正在保存，请等待完成');importGeneration++;const d=importDraft,requestId=importRequestId;importRequestId=null;importDraft=null;importBusy=false;importPasteText='';if(requestId)await api.importCancel(requestId);if(d)await api.importDiscard(d.token);if(page==='import')render();}
async function importAction(a,b){
 if(a==='import-cancel'){await cancelImport();return;}
 if(importBusy||importSaving)return;
 if(['import-file','import-paste','import-image','import-clipboard','import-drop'].includes(a)){
  if(a==='import-image'||a==='import-clipboard')importMode='longcat';
  const text=$('#import-paste')?.value||'';importPasteText=text;if(a==='import-paste'&&!text.trim())throw Error('请先粘贴资料');if(importMode==='longcat'&&!aiConfig.hasKey)throw Error('请先在「AI 设置」中配置 LongCat API Key');const generation=++importGeneration;const requestId=id();importRequestId=requestId;importBusy=true;render();
  try{const result=await (a==='import-drop'?api.importDrop(b.file,{mode:importMode,requestId}):a==='import-paste'?api.importText(text,{mode:importMode,requestId}):a==='import-clipboard'?api.importClipboard({requestId}):api.importChoose({mode:importMode,requestId,imagesOnly:a==='import-image'}));if(generation!==importGeneration){if(result)await api.importDiscard(result.token);return;}if(result){importDraft={...result,title:result.project?.name?result.project.name+' · 项目资料':result.name.replace(/\.[^.]+$/,''),projectId:'',projectName:result.project?.name||result.records[0]?.projectName||'',projectDescription:result.project?.description||'',knowledgeRepo:state.knowledge?.repo||'',confirmed:false,records:result.records.map(r=>({...r,selected:!!(r.name&&r.applicationId)&&!state.packages.some(p=>p.applicationId.toLowerCase()===r.applicationId.toLowerCase())}))};}}
  catch(error){if(generation===importGeneration)throw error;}
  finally{if(generation===importGeneration){importRequestId=null;importBusy=false;render();}}return;
 }
 captureImport();const d=importDraft;if(!d)return;
 if(a==='import-add'){d.records.push({name:'',applicationId:'',branch:'',flavor:'',vpsIp:'',notes:'',fields:[],selected:true});render();return;}
 if(a==='import-add-field'){d.records[Number(b.dataset.row)].fields.push({title:'',content:''});render();return;}
 if(a==='import-remove-field'){d.records[Number(b.dataset.row)].fields.splice(Number(b.dataset.index),1);render();return;}
 if(a==='import-reparse'){const generation=++importGeneration;const requestId=id();importRequestId=requestId;importBusy=true;render();try{const result=await api.importReparse(d.token,d.text,{mode:d.mode||'local',requestId});if(generation!==importGeneration)return;d.records=result.records.map(r=>({...r,selected:!!(r.name&&r.applicationId)&&!state.packages.some(p=>p.applicationId.toLowerCase()===r.applicationId.toLowerCase())}));if(result.project){d.projectName=result.project.name;d.projectDescription=result.project.description;}d.warnings=result.warnings;d.elapsedMs=result.elapsedMs;d.model=result.model||d.model;d.confirmed=false;}catch(error){if(generation===importGeneration)throw error;}finally{if(generation===importGeneration){importRequestId=null;importBusy=false;render();}}return;}
 if(a==='import-save'){
  if(!d.confirmed)throw Error('请先核对资料并勾选确认');
  importSaving=true;render();try{await api.importUpdateText(d.token,d.text);const result=await api.importCommit(d.token,{title:d.title,projectId:d.projectId,projectName:d.projectName,projectDescription:d.projectDescription,knowledgeRepo:d.knowledgeRepo,records:d.records});state=result.state;importDraft=null;importPasteText='';page='projects';selected=result.projectId;render();toast(knowledgeSaveMessage('已导入 '+result.added+' 个应用，并保存项目文档。'));}finally{importSaving=false;render();}
 }
}

async function createProjectFromImage(useClipboard=false){return startProjectImport(useClipboard?'import-clipboard':'import-image');}
async function startProjectImport(action,data){
 if(importBusy||importSaving||importDraft)throw Error('请先完成或取消当前资料导入，再从截图创建项目');
 if(!aiConfig.hasKey)throw Error('请先在「AI 设置」中配置 LongCat API Key');
 $('#modal').close();page='import';selected=null;importMode='longcat';render();
 await importAction(action,data);
}

function importTransferTarget(){
 const modal=$('#modal');
 if(modal?.open)return $('#project-from-image',modal)?'project':null;
 return page==='import'?'import':null;
}
function readyForTransfer(){
 if(importBusy||importSaving||importDraft)throw Error('请先完成或取消当前导入，再添加新的资料');
}
document.addEventListener('paste',async event=>{
 const target=importTransferTarget();
 if(!target||![...(event.clipboardData?.items||[])].some(item=>item.type.startsWith('image/')))return;
 event.preventDefault();
 try{readyForTransfer();if(target==='project')await createProjectFromImage(true);else await importAction('import-clipboard');}
 catch(error){toast(error.message||'截图粘贴失败');}
});
for(const name of ['dragenter','dragover'])document.addEventListener(name,event=>{
 if(![...(event.dataTransfer?.types||[])].includes('Files'))return;
 event.preventDefault();
 const zone=event.target.closest?.('[data-import-drop]');
 if(zone&&importTransferTarget()){zone.classList.add('drag-active');event.dataTransfer.dropEffect='copy';}
 else event.dataTransfer.dropEffect='none';
});
document.addEventListener('dragleave',event=>{const zone=event.target.closest?.('[data-import-drop]');if(zone&&!zone.contains(event.relatedTarget))zone.classList.remove('drag-active');});
document.addEventListener('drop',async event=>{
 const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;
 event.preventDefault();document.querySelectorAll('.drag-active').forEach(el=>el.classList.remove('drag-active'));
 const zone=event.target.closest?.('[data-import-drop]'),target=importTransferTarget();
 if(!zone||!target){toast('请把文件拖到「导入资料」或「新建项目」的虚线区域');return;}
 try{readyForTransfer();if(files.length!==1)throw Error('请一次拖入一个文件，分别核对并保存');if(target==='project')await startProjectImport('import-drop',{file:files[0]});else await importAction('import-drop',{file:files[0]});}
 catch(error){toast(error.message||'文件导入失败');}
});
