"""Opt-in real tmux TUI smoke test; no real IME composition is claimed."""
import os, pathlib, re, shlex, socket, stat, subprocess, tempfile, time
ROOT=pathlib.Path(__file__).resolve().parents[4]
AUTH=pathlib.Path.home()/'.pi/agent/auth.json'

def main():
    server='pi-channel-qa-'+str(os.getpid())
    def tm(*args):
        return subprocess.check_output(['tmux','-L',server,*args],stderr=subprocess.STDOUT).decode()
    def screen(): return tm('capture-pane','-p','-t','qa:0')
    def wait(text,timeout=20):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            value=screen()
            if text in value:return value
            time.sleep(.15)
        raise RuntimeError('Missing TUI text '+text+'; screen='+re.sub(r'pi1\.[a-f0-9]+\.[a-f0-9]+','[PAIRING REDACTED]',screen()))
    def key(*args):
        tm('send-keys','-t','qa:0',*args)
        time.sleep(.25)
    def literal(text):
        tm('send-keys','-t','qa:0','-l',text)
        time.sleep(.1)
    def prompt(text):literal(text);key('Enter')
    with tempfile.TemporaryDirectory(prefix='pi-channel-tui-',dir='/tmp') as tmp:
        base=pathlib.Path(tmp); (base/'auth.json').symlink_to(AUTH)
        (base/'settings.json').write_text('{"transport":"sse","quietStartup":true}')
        command='cd '+shlex.quote(tmp)+' && env PI_CODING_AGENT_DIR='+shlex.quote(tmp)+' PI_OFFLINE=1 pi --no-session --no-extensions --no-context-files --no-skills --no-prompt-templates --no-themes --provider openai-codex --model gpt-5.6-sol -e '+shlex.quote(str(ROOT/'extensions/channel/index.ts'))
        owned_endpoint=None
        try:
            tm('new-session','-d','-s','qa','-x','110','-y','42',command)
            wait('gpt-5.6'); time.sleep(2)
            prompt('/channel'); wait('Channels')
            key('a');wait('创建 Channel 类型');key('Down','Down','Down','Enter')
            wait('频道名称');prompt('终端验收群')
            wait('Pi 显示名');prompt('后端中文甲')
            wait('当前工作介绍')
            literal('负责后端 API');key('C-j');literal('请注意 v2 契约');key('Enter')
            wait('负责模块');prompt('server')
            pairing_view=wait('配对码')
            match=re.search(r'pi1\.([a-f0-9]{32})\.[a-f0-9]{64}', pairing_view)
            if match: owned_endpoint=pathlib.Path('/tmp')/('pi-ch-'+str(os.getuid()))/(match.group(1)+'.sock')
            prompt('/channel');wait('终端验收群');key('Enter')
            wait('查看成员与职责');key('Enter');wait('后端中文甲');key('Enter');wait('职责:')
            # Member details notification returns to management selection.
            wait('查看成员与职责');key('Down','Down','Enter');wait('Pi 显示名');key('Escape')
            wait('查看成员与职责');key('Escape')
            prompt('/channel');wait('终端验收群')
            tm('resize-window','-t','qa:0','-x','42','-y','30');time.sleep(.4)
            assert screen(), 'empty narrow screen'
            key('Escape')
            tm('resize-window','-t','qa:0','-x','110','-y','42')
            prompt('/channel');wait('终端验收群');key('Escape')
            print('PASS real TUI create/group/Chinese text/member details/cancel/reopen/narrow resize; no IME composition tested')
        finally:
            try:tm('kill-session','-t','qa')
            except subprocess.CalledProcessError:pass
            if owned_endpoint and owned_endpoint.exists():
                # This random endpoint was captured from our own create result.
                probe=socket.socket(socket.AF_UNIX)
                try: probe.connect(str(owned_endpoint))
                except OSError:
                    info=owned_endpoint.lstat()
                    if stat.S_ISSOCK(info.st_mode) and info.st_uid==os.getuid():owned_endpoint.unlink()
                finally:probe.close()
if __name__=='__main__':main()
