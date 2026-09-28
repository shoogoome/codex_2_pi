"""Opt-in live Pi acceptance; no tokens or pairing codes are printed/persisted.
Run from repo root: python3 extensions/channel/src/fixtures/piAcceptance.py
Only isolated child processes are stopped. Uses the selected provider's existing local model/auth configuration.
"""
import json, os, pathlib, queue, re, shutil, signal, subprocess, tempfile, threading, time

ROOT = pathlib.Path(__file__).resolve().parents[4]
EXTENSION = ROOT / 'extensions/channel/index.ts'
AUTH = pathlib.Path.home() / '.pi/agent/auth.json'
PROVIDER = os.environ.get('PI_ACCEPTANCE_PROVIDER', 'dgx-spark')
MODEL = os.environ.get('PI_ACCEPTANCE_MODEL', 'deepseek-v4-flash-0731')
MODELS = pathlib.Path.home() / '.pi/agent/models.json'
children = []

class Client:
    def __init__(self, label, base):
        agent = base / label
        agent.mkdir(mode=0o700)
        if AUTH.exists(): (agent / 'auth.json').symlink_to(AUTH)
        if MODELS.exists(): (agent / 'models.json').symlink_to(MODELS)
        (agent / 'settings.json').write_text(json.dumps({'transport':'sse', 'retry': {'enabled':False}, 'quietStartup':True}))
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE='1')
        for key in list(env):
            if key.startswith('PI_CHANNEL_'): env.pop(key)
        args = ['pi','--mode','rpc','--no-session','--no-extensions','--no-context-files','--no-skills','--no-prompt-templates','--no-themes','--provider',PROVIDER,'--model',MODEL,'--thinking','low','--tools','channel_manage,channel_send,bash','-e',str(EXTENSION),'--system-prompt','你是受控频道验收助手。仅执行用户要求的 channel_manage/channel_send 操作。收到对端消息时只回复一句本地确认，不调用发送工具、不自动互相回复，不改文件。调用工具成功后简短回答。']
        self.p = subprocess.Popen(args, cwd=base, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        children.append(self.p)
        self.events = []; self.cv = threading.Condition(); self.label=label
        def read():
            for raw in self.p.stdout:
                try: event=json.loads(raw)
                except Exception: continue
                with self.cv: self.events.append(event); self.cv.notify_all()
        threading.Thread(target=read,daemon=True).start()
        # Diagnostics are deliberately not printed: providers can include request metadata.
        threading.Thread(target=lambda: self.p.stderr.read(),daemon=True).start()
        self.cmd('get_state')
        self.cmd('set_auto_retry',enabled=False)

    def wait(self, predicate, start=0, timeout=150):
        end=time.monotonic()+timeout
        with self.cv:
            while True:
                for e in self.events[start:]:
                    if predicate(e): return e
                if self.p.poll() is not None: raise RuntimeError(self.label+' exited '+str(self.p.returncode))
                remain=end-time.monotonic()
                if remain<=0:
                    errors=[e.get('message',{}).get('errorMessage','') for e in self.events[start:] if e.get('type')=='message_end']
                    errors=[v for v in errors if v]
                    raise RuntimeError(self.label+' timed out; providerError='+str(bool(errors))+' eventTypes='+','.join(sorted(set(e.get('type','') for e in self.events[start:]))))
                self.cv.wait(min(remain,2))
    def cmd(self, kind, **fields):
        ident=str(time.monotonic_ns()); start=len(self.events)
        self.p.stdin.write((json.dumps(dict(type=kind,id=ident,**fields),ensure_ascii=False)+'\n').encode()); self.p.stdin.flush()
        e=self.wait(lambda e:e.get('id')==ident and e.get('type')=='response',start,30)
        if not e.get('success'): raise RuntimeError(self.label+' command failed '+kind)
        return e.get('data')
    def prompt(self,text):
        idle_start=len(self.events)
        if self.cmd('get_state').get('isStreaming'):
            self.wait(lambda e:e.get('type')=='agent_settled',idle_start)
        print(self.label+' model prompt started',flush=True)
        start=len(self.events); self.cmd('prompt',message=text)
        self.wait(lambda e:e.get('type')=='agent_settled',start)
        errors=[e for e in self.events[start:] if e.get('type')=='message_end' and e.get('message',{}).get('stopReason') in ('error','aborted')]
        if errors:
            text=str(errors[-1].get('message',{}).get('errorMessage','unknown'))
            text=re.sub(r'(?:Bearer\s+)?[A-Za-z0-9_\-.]{50,}', '[REDACTED]', text)
            raise RuntimeError(self.label+' provider returned error/aborted: '+text[:1200])
        return self.events[start:]
    def close(self):
        if self.p.poll() is None:
            self.p.stdin.close()
            try:self.p.wait(timeout=10)
            except subprocess.TimeoutExpired:self.p.terminate();self.p.wait(timeout=5)

def tool_result(events,name):
    results=[e for e in events if e.get('type')=='tool_execution_end' and e.get('toolName')==name]
    if not results: raise RuntimeError('Expected real model tool call: '+name)
    if results[-1].get('isError'): raise RuntimeError('Tool failed: '+name)
    return results[-1]['result']
def details(result):
    d=result.get('details',{})
    # channel_manage wraps operation results in details.result
    return d.get('result',d)
def main():
    with tempfile.TemporaryDirectory(prefix='pi-channel-live-',dir='/tmp') as tmp:
        base=pathlib.Path(tmp)
        try:
            a=Client('A',base); b=Client('B',base); c=Client('C',base)
            created=details(tool_result(a.prompt('请创建群频道“验收群”，我的显示名“后端甲”，工作介绍“负责 API 接口\n维护兼容性”，模块 server。只调用创建一次。'),'channel_manage'))
            code=created.get('pairingCode'); assert code, 'missing pairing code'
            astart=len(a.events)
            tool_result(b.prompt('通过配对码 '+code+' 加入频道，我的显示名“前端乙”，介绍“负责 UI 对接”，模块 ui。'),'channel_manage')
            assert not any(e.get('type')=='agent_start' for e in a.events[astart:]),'member join woke owner'
            tool_result(c.prompt('通过配对码 '+code+' 加入频道，我的显示名“测试丙”，介绍“负责验收”，模块 tests。'),'channel_manage')
            assert not any(e.get('type')=='agent_start' for e in a.events[astart:]),'member join woke owner'
            print('PASS natural-language create/join: three real Pi/model processes; roster-only no owner wake',flush=True)
            tool_result(b.prompt('更新“验收群”中我的工作介绍为“负责 UI 对接\n注意 API v2 契约”，显示名保持“前端乙”，模块 ui。'),'channel_manage')
            assert not any(e.get('type')=='agent_start' for e in a.events[astart:]),'identity change woke owner'
            beforeB=len(b.events);beforeC=len(c.events)
            receipt=details(tool_result(a.prompt('向“验收群”发送“验收：API 已改为 v2；无需回复频道”。只发送一次。'),'channel_send'))
            assert receipt.get('delivered') is True, 'not all delivered'
            b.wait(lambda e:e.get('type')=='agent_start',beforeB);c.wait(lambda e:e.get('type')=='agent_start',beforeC)
            b.wait(lambda e:e.get('type')=='agent_settled',beforeB);c.wait(lambda e:e.get('type')=='agent_settled',beforeC)
            assert not any(e.get('type')=='tool_execution_start' and e.get('toolName')=='channel_send' for e in b.events[beforeB:]+c.events[beforeC:]),'echo loop'
            print('PASS idle delivery wakes peers; receipts are delivered; no automatic reply loop',flush=True)
            # A long *tool* leaves a deterministic interval for a peer steer message.
            busy=len(b.events)
            b.cmd('prompt',message='请只调用 bash 执行 python3 -c "import time; time.sleep(12); print(\'BUSY_DONE\')"，等工具完成后简短总结。')
            b.wait(lambda e:e.get('type')=='tool_execution_start' and e.get('toolName')=='bash',busy)
            a.cmd('prompt',message='/channel send 验收群 忙时验收：请记住 API v3，不需要回复频道')
            b.wait(lambda e:e.get('type')=='tool_execution_end' and e.get('toolName')=='bash',busy)
            b.wait(lambda e:e.get('type')=='agent_settled',busy)
            assert not any(e.get('type')=='message_end' and e.get('message',{}).get('stopReason')=='aborted' for e in b.events[busy:])
            messages=b.cmd('get_messages')['messages']
            assert 'API v3' in json.dumps(messages,ensure_ascii=False)
            assert 'BUSY_DONE' in json.dumps(messages,ensure_ascii=False)
            print('PASS busy steer preserves running tool and delivers peer context',flush=True)
            # Freeze only our C process to lose ACKs while B remains healthy.
            # Use the real slash command so model latency cannot outlast the heartbeat window.
            c.wait(lambda e:e.get('type')=='agent_settled',beforeC)
            c.p.send_signal(signal.SIGSTOP)
            partial_start=len(a.events)
            try:
                a.cmd('prompt',message='/channel send 验收群 部分投递验收：无需回复频道')
                event=a.wait(lambda e:e.get('type')=='extension_ui_request' and e.get('method')=='notify' and 'Pi 投递结果' in e.get('message',''),partial_start,15)
                partial=json.loads(event['message'].split('：',1)[1])
                assert partial.get('delivered') is False and partial.get('deliveredTo') and partial.get('unknown'), 'expected healthy delivery plus missing ACK'
            finally:
                c.p.send_signal(signal.SIGCONT)
            print('PASS real Pi partial receipt: healthy peer delivered, paused peer unknown; no false full success',flush=True)
            # Rotation keeps current peers; a member that leaves cannot reuse the old invitation.
            tool_result(c.prompt('从“验收群”退出。只调用 leave 一次。'),'channel_manage')
            tool_result(a.prompt('撤销“验收群”的配对码。只调用 pairing revoke 一次，不能销毁频道。'),'channel_manage')
            failed_join=c.prompt('使用旧配对码 '+code+' 加入频道，身份显示名“测试丙”，介绍“负责验收”。只调用 join 一次；如果失败就报告失败并停止，不重试也不创建新频道。')
            joins=[e for e in failed_join if e.get('type')=='tool_execution_end' and e.get('toolName')=='channel_manage']
            assert joins and joins[-1].get('isError'), 'revoked pairing unexpectedly accepted'
            print('PASS revoked pairing rejected through actual model tool call',flush=True)
            a.close()
            b.cmd('prompt',message='/channel status')
            status=b.wait(lambda e:e.get('type')=='extension_ui_request' and e.get('method')=='notify' and 'stopped' in e.get('message',''),timeout=20)
            assert status
            print('PASS creator exit closes member channel; no takeover',flush=True)
        finally:
            for p in children:
                if p.poll() is None:
                    try:p.stdin.close();p.wait(timeout=5)
                    except Exception:p.kill();p.wait()

if __name__=='__main__': main()
