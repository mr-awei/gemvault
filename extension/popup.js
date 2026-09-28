const msg = document.getElementById('msg');
const say = (t) => (msg.textContent = t);

document.getElementById('batch').onclick = () => {
  say('抓取中…');
  chrome.runtime.sendMessage(
    { type: 'batch', keyword: document.getElementById('kw').value.trim(), tags: document.getElementById('tags').value.trim() },
    (r) => {
      if (!r) return say('无法连接插件后台');
      say(r.ok ? `已入库 ${r.saved} 张（共 ${r.total}）` : '失败：' + r.error);
    }
  );
};

document.getElementById('shot').onclick = () => {
  say('截图并上传中…');
  chrome.runtime.sendMessage(
    { type: 'shot', keyword: document.getElementById('kw').value.trim(), tags: document.getElementById('tags').value.trim() },
    (r) => {
      if (!r) return say('无法连接插件后台');
      say(r.ok ? `已入库 ${r.saved} 张（共 ${r.total}）` : '失败：' + r.error);
    }
  );
};
