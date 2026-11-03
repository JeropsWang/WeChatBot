"""Explicitly authorized, temporary one-byte Qt accessibility experiment.

No disk patch, database access, secret scan, DLL injection or process restart.
Create artifacts/uia-lease-release to finish; finally restores the original byte.
Only the already inspected SHA-256 and unique gate are accepted.
"""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
from pathlib import Path
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'bridge'))
from diagnostics import inventory
from accessibility_lease import maintain_accessibility
import win32api
import win32process
import win32event
from diagnostics import process_path
from compatibility_paths import select_visible_client, select_weixin_module

parser=argparse.ArgumentParser()
parser.add_argument('--enable-for-test',action='store_true')
parser.add_argument('--enable-for-bridge',action='store_true')
parser.add_argument('--watch-bridge-pid',type=int)
parser.add_argument('--state-dir',default=str(ROOT/'data'))
args=parser.parse_args()
if args.enable_for_test == args.enable_for_bridge:raise SystemExit('Choose one explicitly authorized accessibility mode')
if args.enable_for_bridge and not args.watch_bridge_pid:raise SystemExit('Bridge mode requires the owned launcher PID')
# 从唯一可见主进程实际加载模块定位，路径变化不放宽下方哈希和指令校验。
client=select_visible_client(inventory()['processes'])
matching=[client]
pid=client['pid']
query_handle=win32api.OpenProcess(0x0400|0x0010,False,pid)
try:
    module_path=select_weixin_module([win32process.GetModuleFileNameEx(query_handle,m) for m in win32process.EnumProcessModules(query_handle)])
finally:
    query_handle.Close()
# Pinned to the statically inspected build; never guess after an upgrade.
report={'path':module_path,
        'sha256':'e0428a7b691853de496532523c2c09aa095f90941c37c9f4cfb3f137f3c66556',
        'candidates':[{'checkRva':8801010,'gateRva':188336600,'distanceToCoreReference':2341,
                       'checkBytes':'4885c90f84f7060000803dd67eb30a000f84ea0600004889'}]}
expected='e0428a7b691853de496532523c2c09aa095f90941c37c9f4cfb3f137f3c66556'
if report['sha256']!=expected or hashlib.sha256(Path(report['path']).read_bytes()).hexdigest()!=expected:
    raise RuntimeError('Inspected binary identity changed')
if len(report['candidates'])!=1:raise RuntimeError('A unique gate is required')
candidate=report['candidates'][0]
if candidate['gateRva']!=188336600 or candidate['distanceToCoreReference']!=2341:
    raise RuntimeError('Inspected gate evidence changed')
owner=None
if args.enable_for_bridge:
    if process_path(args.watch_bridge_pid).casefold()!=str(ROOT/'.venv'/'Scripts'/'python.exe').casefold():
        raise RuntimeError('The watched process is not this application Python launcher')
    owner=win32api.OpenProcess(0x00100000,False,args.watch_bridge_pid)
mutex=win32event.CreateMutex(None,False,'Local\\WeChatBotQtAccessibilityFlag')
if win32api.GetLastError()==183:
    mutex.Close()
    raise RuntimeError('Another authorized accessibility lease is active; stop it first')
handle=win32api.OpenProcess(0x0400|0x0010|0x0020|0x0008,False,pid)
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
for name in ['ReadProcessMemory','WriteProcessMemory']:
    function=getattr(kernel,name)
    function.argtypes=[wintypes.HANDLE,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.POINTER(ctypes.c_size_t)]
    function.restype=wintypes.BOOL
def read(address,size):
    data=ctypes.create_string_buffer(size);count=ctypes.c_size_t()
    if not kernel.ReadProcessMemory(int(handle),address,data,size,ctypes.byref(count)) or count.value!=size:
        raise RuntimeError('Bounded runtime read failed')
    return data.raw
def write(value):
    data=ctypes.create_string_buffer(value);count=ctypes.c_size_t()
    if not kernel.WriteProcessMemory(int(handle),address,data,1,ctypes.byref(count)) or count.value!=1:
        raise RuntimeError('Accessibility flag write failed')
    if read(address,1)!=value:raise RuntimeError('Accessibility flag read-back failed')
output=(Path(args.state_dir)/'runtime-accessibility.json') if args.enable_for_bridge else ROOT/'artifacts'/'runtime-accessibility-lease.json'
output.parent.mkdir(parents=True,exist_ok=True)
release=ROOT/'artifacts'/'uia-lease-release'
result={'pid':pid,'target':matching[0]['executable'],'gateRva':candidate['gateRva'],'messagesRead':False,'watchedBridgePid':args.watch_bridge_pid}
original=None
written=False
def save():output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
try:
    modules=[m for m in win32process.EnumProcessModules(handle)
             if win32process.GetModuleFileNameEx(handle,m).casefold()==report['path'].casefold()]
    if len(modules)!=1:raise RuntimeError('Loaded module identity is ambiguous')
    base=modules[0]
    instructions=bytes.fromhex(candidate['checkBytes'])
    if read(base+candidate['checkRva'],len(instructions))!=instructions:
        raise RuntimeError('Runtime instructions do not match inspected file')
    address=base+candidate['gateRva']
    original=read(address,1)
    if original not in (b'\0',b'\1'):raise RuntimeError('Unexpected flag value')
    result['originalByte']=original.hex()
    release.unlink(missing_ok=True)
    # Record restoration information before the single-byte operation.
    result['stage']='prepared';save()
    if owner and win32event.WaitForSingleObject(owner,0)!=win32event.WAIT_TIMEOUT:
        raise RuntimeError('Bridge exited before compatibility activation')
    written=True
    write(b'\1')
    time.sleep(1)
    result['diagnosisWhileEnabled']=inventory()
    result['supported']=result['diagnosisWhileEnabled']['supported']
    result['stage']='enabled';save()
    print(json.dumps({'stage':'enabled','pid':pid,'supported':result['supported']},ensure_ascii=False),flush=True)
    if not result['supported']:raise RuntimeError('The inspected flag did not restore a supported UIA tree')
    if result['supported']:
        if owner:
            # Sibling of the bridge: survives its process-tree termination.
            def alive():return win32event.WaitForSingleObject(owner,0)==win32event.WAIT_TIMEOUT
            def enable_checked():
                if read(base+candidate['checkRva'],len(instructions))!=instructions:
                    raise RuntimeError('Runtime instructions changed during compatibility session')
                if not alive():return False
                write(b'\1')
            def report_reactivation(update):
                result.update(update)
                result['lastReactivatedAt']=time.time()
                save()
                print(json.dumps({'stage':'reactivated',**update}),flush=True)
            maintain_accessibility(lambda:read(address,1),enable_checked,alive,report_reactivation)
        else:
            deadline=time.monotonic()+900
            while time.monotonic()<deadline and not release.exists():time.sleep(0.5)
finally:
    if written:
        try:
            write(original)
            result['originalByteRestored']=True
        except Exception as error:
            result['originalByteRestored']=False
            result['restorationError']=str(error)
    result['stage']='finished';save()
    handle.Close()
    mutex.Close()
    if owner:owner.Close()
    print(json.dumps({'stage':'restored','ok':result.get('originalByteRestored')},ensure_ascii=False),flush=True)
    if written and not result.get('originalByteRestored'):raise RuntimeError('Original accessibility byte restoration could not be verified; inspect the saved report')
