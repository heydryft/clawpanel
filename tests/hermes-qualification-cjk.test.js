// 字体视觉红灯先于实现；本文件只跑隔离契约/发布路径，不执行apt或本机GUI。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runner=path.join(root,'scripts/hermes-qualification-browser.py'),python=process.platform==='win32'?'python':'python3'
function py(body){const code=`import importlib.util,json,copy,tempfile,pathlib\nspec=importlib.util.spec_from_file_location('cjk',${JSON.stringify(runner)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ndef reject(fn):\n try: fn()\n except (AssertionError,ValueError,KeyError): return\n raise AssertionError('negative accepted')\n`+body;const r=spawnSync(python,['-B','-X','utf8','-c',code],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,(r.stdout+r.stderr).slice(-4500));return r.stdout}
test('fontconfig cmap必须逐码点覆盖真实中文；加载成功/LastResort/零glyph不能补绿',()=>{py(String.raw`
assert hasattr(m,'parse_fc_charset') and hasattr(m,'assert_cjk_coverage')
assert m.parse_fc_charset('20-7e 4e00-9fff')==[(32,126),(19968,40959)]
for bad in ['', 'xyz','9-1','110000','4e00 4d00','1-2-3']:reject(lambda:m.parse_fc_charset(bad))
face={'file':'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','index':2,'family':'Noto Sans CJK SC','postscriptName':'NotoSansCJKsc-Regular','sha256':'a'*64,'charset':'20-7e 4e00-9fff'}
fonts=[{'familyName':'Noto Sans CJK SC','postScriptName':'NotoSansCJKsc-Regular','glyphCount':8,'isCustomFont':False}]
r=m.assert_cjk_coverage('浏览器完整回复模型',fonts,[face]);assert r['missingCodepoints']==[] and len(r['codepoints'])>0
m.assert_cjk_coverage('中文',[{**fonts[0],'glyphCount':2.0}],[face])
for bad in [[],[{**fonts[0],'glyphCount':0}],[{**fonts[0],'glyphCount':'8'}],[{**fonts[0],'glyphCount':True}],[{**fonts[0],'glyphCount':float('inf')}],[{**fonts[0],'glyphCount':2.5}],[{**fonts[0],'isCustomFont':True}],[{**fonts[0],'postScriptName':'LastResort'}]]:reject(lambda:m.assert_cjk_coverage('中文',bad,[face]))
reject(lambda:m.assert_cjk_coverage('中文',fonts,[{**face,'charset':'20-7e'}]));reject(lambda:m.assert_cjk_coverage('ASCII only',fonts,[face]))
print(json.dumps({'cmapContract':True,'nativeOrLiveUI':False}))
`)})
test('真实节点字体证据不造DOM，缺CDP/错字形/截图缺失仍红',()=>{py(String.raw`
assert hasattr(m,'capture_cjk_sample') and hasattr(m,'validate_cjk_report')
class Session:
 def send(self,name,args=None):
  if name=='DOM.getDocument':return {'root':{'nodeId':1}}
  if name=='DOM.querySelector':return {'nodeId':2}
  if name=='CSS.getPlatformFontsForNode':return {'fonts':[{'familyName':'Noto Sans CJK SC','postScriptName':'NotoSansCJKsc-Regular','glyphCount':2,'isCustomFont':False}]}
  return {}
 def detach(self):pass
class Context:
 def new_cdp_session(self,page):return Session()
class Locator:
 def evaluate(self,script):return {'text':'中文','selector':'html > body > p','visible':True,'fontFamily':'sans-serif'}
class Page:
 context=Context()
face={'file':'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','index':2,'family':'Noto Sans CJK SC','postscriptName':'NotoSansCJKsc-Regular','sha256':'a'*64,'charset':'4e00-9fff'}
with tempfile.TemporaryDirectory() as d:
 png=pathlib.Path(d,'reply.png');png.write_bytes(bytes.fromhex('89504e470d0a1a0a')+b'isolated-not-a-real-screenshot')
 r=m.capture_cjk_sample(Page(),Locator(),'中文','reply',png,[face]);assert r['missingCodepoints']==[] and r['screenshotSha256']
 reject(lambda:m.capture_cjk_sample(Page(),Locator(),'其他','reply',png,[face]))
 reject(lambda:m.capture_cjk_sample(Page(),Locator(),'中文','reply',pathlib.Path(d,'absent.png'),[face]))
 proof={'required':True,'environment':{'beforeSha256':'b'*64,'afterSha256':'c'*64,'faces':[face]},'samples':[r,{**r,'label':'restarted','screenshot':'restarted.png'}]};m.validate_cjk_report(proof)
 for change in [lambda x:x['samples'].pop(),lambda x:x['samples'][0].update(missingCodepoints=['4e2d']),lambda x:x['samples'][0].update(platformFonts=[]),lambda x:x['samples'][0].update(screenshotSha256=''),lambda x:x['environment'].update(afterSha256='')]:
  bad=copy.deepcopy(proof);change(bad);reject(lambda:m.validate_cjk_report(bad))
print(json.dumps({'fixtureCDP':True,'realBrowser':False}))
`)})
test('workflow仅host私有字体记录，原Chromium/90min/210/42/8及fresh目录保持',()=>{
 const source=fs.readFileSync(path.join(root,'.github/workflows/hermes-qualification.yml'),'utf8'),linux=source.split('  linux-long-ui:')[1];assert.ok(linux)
 for(const text of ['prepare_private_fonts','--font-environment','playwright==1.58.0','timeout-minutes: 90','--hold 210'])assert.ok(linux.includes(text),text)
 assert.ok(!/sudo|apt-get[^\n]*(?:update|install)|fc-cache -f \/usr/.test(linux));assert.ok(linux.indexOf('test ! -e "$EVIDENCE"')<linux.indexOf('prepare_private_fonts'));assert.ok(!/mkdir[^\n]*browser-round/.test(linux))
 const s=fs.readFileSync(runner,'utf8');for(const t of ['AllowUnauthenticated=false','AllowInsecureRepositories=false','fontconfig-before.json','fontconfig-after.json'])assert.ok(s.includes(t),t);assert.ok(s.includes('CSS.getPlatformFontsForNode'));assert.ok(s.includes('capture_cjk_sample(page,'));assert.ok(!/document\.fonts\.check|add_style_tag|set_content\(/.test(s));assert.ok(s.includes('210 <= a.hold <= 3600'))
})
test('字体metadata经现有publishEvidence脱敏；字体本体排除且不预建UI fresh根',async()=>{
 const {publishEvidence}=await import('../scripts/test-hermes-windows-qualification.mjs');const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'cjk-publish-'))),source=path.join(dir,'evidence'),output=path.join(dir,'public');fs.mkdirSync(source)
 try{fs.writeFileSync(path.join(source,'fontconfig-before.json'),JSON.stringify({apiKey:'CJK-PUBLISH-SECRET-123',fonts:[]}));fs.writeFileSync(path.join(source,'fontconfig-after.json'),JSON.stringify({fontSHA256:'a'.repeat(64),version:'fixture'}));fs.writeFileSync(path.join(source,'font.ttc'),'fixture font must not upload');assert.equal(fs.existsSync(path.join(source,'browser-round1')),false)
 await publishEvidence({roots:{evidence:source},output});assert.ok(fs.existsSync(path.join(output,'evidence/fontconfig-after.json')));assert.equal(fs.existsSync(path.join(output,'evidence/font.ttc')),false);assert.ok(!fs.readFileSync(path.join(output,'evidence/fontconfig-before.json'),'utf8').includes('CJK-PUBLISH-SECRET-123'));assert.equal(fs.existsSync(path.join(source,'browser-round1')),false)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('字体环境before/after独立证据；after只接受私有成员且缺工具/漂移均红',()=>{py(String.raw`
import hashlib
assert hasattr(m,'font_environment') and hasattr(m,'read_font_environment')
m.sys.platform='linux'
def command(args,**kwargs):
 if args[0]=='dpkg-query':return {'args':args,'exitCode':0,'stdout':'fontconfig\t2.15.0\n'}
 if args[0]=='fc-query':return {'args':args,'exitCode':0,'stdout':'2\tNoto Sans CJK SC\tNotoSansCJKsc-Regular\t20-7e 4e00-9fff\n'}
 return {'args':args,'exitCode':0,'stdout':'fixture-only'}
m.font_command=command
reject(lambda:m.font_environment('after'))
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d).resolve();private=root/'private';private.mkdir();(private/'fonts').mkdir();(private/'cache').mkdir();(private/'download').mkdir()
 config=private/'fonts.conf';config.write_text('<fontconfig/>');deb=private/'download/font.deb';deb.write_bytes(b'inert fixture')
 fonts=[]
 for name in ['NotoSansCJK-Bold.ttc','NotoSansCJK-Regular.ttc','NotoSerifCJK-Bold.ttc','NotoSerifCJK-Regular.ttc']:
  f=private/'fonts'/name;f.write_bytes(name.encode());fonts.append({'file':str(f),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
 proof={'root':str(private),'config':str(config),'configSha256':hashlib.sha256(config.read_bytes()).hexdigest(),'archive':str(deb),'archiveSha256':hashlib.sha256(deb.read_bytes()).hexdigest(),'archiveBytes':deb.stat().st_size,'fonts':fonts,'package':{'version':'fixture-only'}}
 before=m.font_environment('before');after=m.font_environment('after',proof);assert after['faces'] and before['phase']=='before' and after['phase']=='after'
 (root/'fontconfig-before.json').write_text(json.dumps(before));(root/'fontconfig-after.json').write_text(json.dumps(after));receipt=m.read_font_environment(root);assert receipt['beforeSha256'] and receipt['afterSha256'] and receipt['childEnv']['FONTCONFIG_FILE']==str(config);assert not (root/'browser-round1').exists()
 (root/'fontconfig-after.json').write_text(json.dumps({**after,'faces':[]}));reject(lambda:m.read_font_environment(root))
 m.font_command=lambda args,**kwargs:{'args':args,'exitCode':1,'stdout':''};reject(lambda:m.font_environment('after',proof));assert m.font_environment('before')['faces']==[]
print(json.dumps({'fontconfigCalls':'fixtures only','apt':False,'GUI':False}))
`)})

// 私有下载方案先列全部拒绝场景；不改变既有Linux禁提权断言。
test('受信Ubuntu索引与精确version/URI/size/SHA256必须同一下载契约',()=>{py(String.raw`
assert hasattr(m,'validate_font_download')
version='1:20230817+repack1-3'
meta='Package: fonts-noto-cjk\nVersion: '+version+'\nArchitecture: all\nFilename: pool/main/f/fonts-noto-cjk/fonts-noto-cjk_20230817_all.deb\nSize: 123\nInstalled-Size: 400\nSHA256: '+'a'*64+'\n'
index='Identifier: Packages\nOrigin: Ubuntu\nLabel: Ubuntu\nTrusted: yes\nSite: http://archive.ubuntu.com/ubuntu\nFilename: /var/lib/apt/lists/fixture_Packages\n'
uri="'http://archive.ubuntu.com/ubuntu/pool/main/f/fonts-noto-cjk/fonts-noto-cjk_20230817_all.deb' fonts-noto-cjk_20230817_all.deb 123 SHA256:"+'a'*64
p=m.validate_font_download(meta,index,uri,version);assert p['sha256']=='a'*64 and p['bytes']==123 and p['unpackedLimit']==409600
for bad in [meta.replace('Package: fonts-noto-cjk','Package: other'),meta.replace('Architecture: all','Architecture: amd64'),meta.replace(version,'2'),meta.replace('Size: 123','Size: 0'),meta.replace('Size: 123','Size: 999999999'),meta.replace('Installed-Size: 400','Installed-Size: 0'),meta.replace('SHA256: '+'a'*64,'SHA256: bad'),meta.replace('pool/main/','../'),meta+'Size: 123\n']:
 reject(lambda:m.validate_font_download(bad,index,uri,version))
for bad in [index.replace('Trusted: yes','Trusted: no'),index.replace('Origin: Ubuntu','Origin: Other'),index.replace('archive.ubuntu.com','attacker.invalid')]:reject(lambda:m.validate_font_download(meta,bad,uri,version))
for bad in [uri.replace('123 SHA256','124 SHA256'),uri.replace('a'*64,'b'*64),uri.replace('archive.ubuntu.com','attacker.invalid'),uri+'\n'+uri]:reject(lambda:m.validate_font_download(meta,index,bad,version))
print(json.dumps({'aptMetadata':'isolated only','aptExecuted':False}))
`)})
test('真实tar流只提取四个普通字体成员；遍历重复链接设备超额均红',()=>{py(String.raw`
import io,tarfile,hashlib
assert hasattr(m,'extract_private_font_tar')
names=['NotoSansCJK-Bold.ttc','NotoSansCJK-Regular.ttc','NotoSerifCJK-Bold.ttc','NotoSerifCJK-Regular.ttc']
def archive(extra=None):
 b=io.BytesIO()
 with tarfile.open(fileobj=b,mode='w') as t:
  for name in names:
   raw=('isolated '+name).encode();i=tarfile.TarInfo('./usr/share/fonts/opentype/noto/'+name);i.size=len(raw);t.addfile(i,io.BytesIO(raw))
  i=tarfile.TarInfo('./usr/share/doc/fonts-noto-cjk/copyright');i.size=4;t.addfile(i,io.BytesIO(b'doc!'))
  if extra:
   i,raw=extra;t.addfile(i,io.BytesIO(raw))
 b.seek(0);return b
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);dest=root/'good';out=m.extract_private_font_tar(archive(),dest,409600);assert len(out['fonts'])==4 and len(list(dest.iterdir()))==4;assert not (root/'usr').exists()
 for n,kind in [('../escape.ttc',tarfile.REGTYPE),('./usr/share/fonts/opentype/noto/'+names[0],tarfile.REGTYPE),('./usr/share/fonts/opentype//noto/'+names[0],tarfile.REGTYPE),('./usr/share/fonts/opentype/noto/evil.ttc',tarfile.SYMTYPE),('./usr/share/fonts/opentype/noto/other.ttc',tarfile.REGTYPE),('./device',tarfile.CHRTYPE)]:
  i=tarfile.TarInfo(n);i.type=kind;i.linkname='/outside';i.size=0
  reject(lambda:m.extract_private_font_tar(archive((i,b'')),root/('bad'+str(len(list(root.iterdir())))),409600))
 reject(lambda:m.extract_private_font_tar(archive(),root/'over',2))
print(json.dumps({'realTarParser':True,'data':'inert fixtures','hostFontInstall':False}))
`)})
test('私有fontconfig路径与字节/归档漂移受检且只克隆子环境',()=>{py(String.raw`
import os,hashlib
assert hasattr(m,'private_font_environment') and hasattr(m,'verify_private_fonts')
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d).resolve();(root/'fonts').mkdir();(root/'cache').mkdir();config=root/'fonts.conf';config.write_text('<fontconfig/>');(root/'download').mkdir();deb=root/'download/font.deb';deb.write_bytes(b'inert fixture')
 fonts=[]
 for name in ['NotoSansCJK-Bold.ttc','NotoSansCJK-Regular.ttc','NotoSerifCJK-Bold.ttc','NotoSerifCJK-Regular.ttc']:
  f=root/'fonts'/name;f.write_bytes(name.encode());fonts.append({'file':str(f),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
 proof={'root':str(root),'config':str(config),'configSha256':hashlib.sha256(config.read_bytes()).hexdigest(),'archive':str(deb),'archiveSha256':hashlib.sha256(deb.read_bytes()).hexdigest(),'archiveBytes':deb.stat().st_size,'fonts':fonts}
 parent={'KEEP':'same','FONTCONFIG_FILE':'old','FONTCONFIG_SYSROOT':'/foreign'};before=dict(os.environ);child=m.private_font_environment(proof,parent);assert child['KEEP']=='same' and child['FONTCONFIG_FILE']==str(config) and 'FONTCONFIG_SYSROOT' not in child and parent=={'KEEP':'same','FONTCONFIG_FILE':'old','FONTCONFIG_SYSROOT':'/foreign'} and dict(os.environ)==before
 m.verify_private_fonts(proof)
 for k,v in [('configSha256','a'*64),('archiveSha256','a'*64),('archiveBytes',0),('config',str(root.parent/'fonts.conf'))]:
  reject(lambda:m.verify_private_fonts({**proof,k:v}))
 fonts[0]['sha256']='a'*64;reject(lambda:m.verify_private_fonts(proof))
print(json.dumps({'envMutation':False,'fontInstall':False}))
`)})

test('隔离准备E2E：真实私有文件/tar/收据到childenv，错误归档必须在解包前红',()=>{py(String.raw`
import io,tarfile,hashlib,os,xml.etree.ElementTree as ET
assert hasattr(m,'prepare_private_fonts')
m.sys.platform='linux';m.os.geteuid=lambda:1001
version='1:20230817+repack1-3';payload=b'inert deb fixture, no host install';sha=hashlib.sha256(payload).hexdigest();filename='fonts-noto-cjk_20230817_all.deb'
meta='Package: fonts-noto-cjk\nVersion: '+version+'\nArchitecture: all\nFilename: pool/main/f/fonts-noto-cjk/'+filename+'\nSize: '+str(len(payload))+'\nInstalled-Size: 400\nSHA256: '+sha+'\n'
index='Identifier: Packages\nOrigin: Ubuntu\nLabel: Ubuntu\nTrusted: yes\nSite: http://archive.ubuntu.com/ubuntu\nFilename: /var/lib/apt/lists/fixture_Packages\n'
uri="'http://archive.ubuntu.com/ubuntu/pool/main/f/fonts-noto-cjk/"+filename+"' "+filename+' '+str(len(payload))+' SHA256:'+sha
stream=io.BytesIO()
with tarfile.open(fileobj=stream,mode='w') as t:
 for name in sorted(m.FONT_NAMES):
  value=('inert '+name).encode();i=tarfile.TarInfo('./usr/share/fonts/opentype/noto/'+name);i.size=len(value);t.addfile(i,io.BytesIO(value))
 i=tarfile.TarInfo('./etc/fonts/conf.d/70-fonts-noto-cjk.conf');i.type=tarfile.SYMTYPE;i.linkname='/must-not-extract';t.addfile(i)
raw=stream.getvalue();calls=[];tamper=False;processes=[];parent=dict(os.environ)
def command(args,**kwargs):
 calls.append((args,kwargs));stdout='fixture'
 if args[:2]==['apt-cache','policy']:stdout='  Candidate: '+version+'\n'
 elif args[:2]==['apt-cache','show']:stdout=meta
 elif args[:2]==['apt-get','indextargets']:stdout=index
 elif args[0]=='apt-get' and '--print-uris' in args:stdout=uri
 elif args[0]=='apt-get':
  assert 'download' in args and 'install' not in args and 'update' not in args and args[-1]=='fonts-noto-cjk='+version
  pathlib.Path(kwargs['cwd'],filename).write_bytes(payload+(b'bad' if tamper else b''))
 elif args[:2]==['dpkg-deb','--field']:stdout=meta
 elif args[0]=='dpkg-query':stdout='fontconfig\t2.15.0\n'
 elif args[0]=='fc-query':stdout='2\tNoto Sans CJK SC\tNotoSansCJKsc-Regular\t4e00-9fff\n'
 if args[0] in ('fc-cache','fc-query'):
  env=kwargs['env'];assert env['FONTCONFIG_FILE'].endswith('fonts.conf') and '/usr/share/fonts' not in env['XDG_CACHE_HOME']
 return {'args':args,'exitCode':0,'stdout':stdout,'error':''}
class Process:
 def __init__(self,args,**kwargs):
  processes.append(args);assert args[:2]==['dpkg-deb','--fsys-tarfile'];self.stdout=io.BytesIO(raw);self.closed=False
 def __enter__(self):return self
 def __exit__(self,*args):self.stdout.close()
 def wait(self,timeout=None):self.closed=True;return 0
 def poll(self):return 0 if self.closed else None
 def kill(self):self.closed=True
m.font_command=command;m.subprocess.Popen=Process
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d).resolve();out=root/'evidence';out.mkdir();private=root/'private';m.prepare_private_fonts(out,private)
 r=json.loads((out/'fontconfig-after.json').read_text());assert r['private']['archiveSha256']==sha and len(r['private']['fonts'])==4;env=m.read_font_environment(out)['childEnv'];assert env['FONTCONFIG_FILE']==str(private/'fonts.conf')
 tree=ET.fromstring((private/'fonts.conf').read_text());assert [e.text for e in tree.findall('cachedir')]==[str(private/'cache')] and [e.text for e in tree.findall('dir')]==[str(private/'fonts')] and not tree.findall('include');assert not (private/'etc').exists() and not (out/'browser-round1').exists();assert dict(os.environ)==parent
 reject(lambda:m.prepare_private_fonts(out,private))
 tamper=True;out2=root/'evidence2';out2.mkdir();before=len(processes);reject(lambda:m.prepare_private_fonts(out2,root/'bad-private'));assert len(processes)==before and not (out2/'fontconfig-after.json').exists()
print(json.dumps({'isolatedPreparationE2E':True,'actualAPT':False,'actualFontOrGUIInstall':False}))
`)})
