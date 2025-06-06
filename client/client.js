var port = 28888;
var heartInterval = 25000;

var frontpage = [
  "实时聊天应用，无消息记录",
  "",
  "https://hack.chat/?频道名",
  "",
  "公共频道示例：",
  "",
  "?lounge(休闲)、?tech(技术)、?games(游戏)"
].join("\n");

// 全局变量记录原始滚动位置
var originalScrollPosition = 0;

// 检测iOS
var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

if (isIOS) {
  document.body.style.height = "100%";
  document.body.style.overflow = "hidden";

  // 防止iOS缩放
  document.addEventListener("gesturestart", function (e) {
    e.preventDefault();
  });
}

function $(query) {
  return document.querySelector(query);
}

function localStorageGet(key) {
  try {
    return window.localStorage[key];
  } catch (e) {}
}

function localStorageSet(key, val) {
  try {
    window.localStorage[key] = val;
  } catch (e) {}
}

var ws;
var myNick = localStorageGet("my-nick");
var myChannel = window.location.search.replace(/^\?/, "");
var lastSent = [""];
var lastSentPos = 0;

// Ping server every 50 seconds to retain WebSocket connection
window.setInterval(function () {
  send({ cmd: "ping" });
}, heartInterval);

function join(channel) {
  if (document.domain == "hack.chat") {
    // For https://hack.chat/
    ws = new WebSocket("wss://hack.chat/chat-ws");
  } else {
    // for local installs
    ws = new WebSocket(`ws://${document.domain}:${port}`);
  }

  var wasConnected = false;
  var pongTimeout;

  ws.onopen = function () {
    if (!wasConnected) {
      if (location.hash) {
        myNick = location.hash.substr(1);
      } else {
        myNick = prompt("请输入用户名(英文字母或者数字):", myNick);
      }
    }
    if (myNick) {
      localStorageSet("my-nick", myNick);
      send({ cmd: "join", channel: channel, nick: myNick });
    }
    wasConnected = true;
  };

  ws.onclose = function () {
    // 清除心跳检测
    clearTimeout(pongTimeout); 

    if (wasConnected) {
      pushMessage({ nick: "!", text: "Server disconnected. Attempting to reconnect..." });
    }
    window.setTimeout(function () {
      join(channel);
    }, 2000+ Math.random()*3000);
  };

  ws.onmessage = function (message) {
    clearTimeout(pongTimeout);
    var args = JSON.parse(message.data);
    // 忽略pong
    if (args.cmd === "pong") return;

    // 设置下次超时检测（60秒）
    pongTimeout = setTimeout(() => {
      ws.close(); // 主动断开触发重连
    }, 60000);

    var cmd = args.cmd;
    var command = COMMANDS[cmd];
    command.call(null, args);

  };
}

var COMMANDS = {
  chat: function (args) {
    if (ignoredUsers.indexOf(args.nick) >= 0) {
      return;
    }
    pushMessage(args);
  },
  info: function (args) {
    args.nick = "*";
    pushMessage(args);
  },
  warn: function (args) {
    args.nick = "!";
    pushMessage(args);
  },
  onlineSet: function (args) {
    var nicks = args.nicks;
    usersClear();
    nicks.forEach(function (nick) {
      userAdd(nick);
    });
    pushMessage({ nick: "*", text: "Users online: " + nicks.join(", ") });
  },
  onlineAdd: function (args) {
    var nick = args.nick;
    userAdd(nick);
    if ($("#joined-left").checked) {
      pushMessage({ nick: "*", text: nick + " joined" });
    }
  },
  onlineRemove: function (args) {
    var nick = args.nick;
    userRemove(nick);
    if ($("#joined-left").checked) {
      pushMessage({ nick: "*", text: nick + " left" });
    }
  }
};

function pushMessage(args) {
  // Message container
  var messageEl = document.createElement("div");
  messageEl.classList.add("message");

  if (args.nick == myNick) {
    messageEl.classList.add("me");
  } else if (args.nick == "!") {
    messageEl.classList.add("warn");
  } else if (args.nick == "*") {
    messageEl.classList.add("info");
  } else if (args.admin) {
    messageEl.classList.add("admin");
  } else if (args.mod) {
    messageEl.classList.add("mod");
  }

  // Nickname
  var nickSpanEl = document.createElement("span");
  nickSpanEl.classList.add("nick");
  messageEl.appendChild(nickSpanEl);

  if (args.trip) {
    var tripEl = document.createElement("span");
    tripEl.textContent = args.trip + " ";
    tripEl.classList.add("trip");
    nickSpanEl.appendChild(tripEl);
  }

  if (args.nick) {
    var nickLinkEl = document.createElement("a");
    nickLinkEl.textContent = args.nick;
    nickLinkEl.onclick = function () {
      insertAtCursor("@" + args.nick + " ");
      $("#chatinput").focus();
    };
    var date = new Date(args.time || Date.now());
    nickLinkEl.title = date.toLocaleString();
    nickSpanEl.appendChild(nickLinkEl);
  }

  // Text
  var textEl = document.createElement("pre");
  textEl.classList.add("text");

  textEl.textContent = args.text || "";
  textEl.innerHTML = textEl.innerHTML.replace(/(\?|https?:\/\/)\S+?(?=[,.!?:)]?\s|$)/g, parseLinks);

  if ($("#parse-latex").checked) {
    // Temporary hotfix for \rule spamming, see https://github.com/Khan/KaTeX/issues/109
    textEl.innerHTML = textEl.innerHTML.replace(/\\rule|\\\\\s*\[.*?\]/g, "");
    try {
      renderMathInElement(textEl, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false }
        ]
      });
    } catch (e) {
      console.warn(e);
    }
  }

  messageEl.appendChild(textEl);

  // Scroll to bottom
  var atBottom = isAtBottom();
  $("#messages").appendChild(messageEl);
  if (atBottom) {
    window.scrollTo(0, document.body.scrollHeight);
  }

  unread += 1;
  updateTitle();
}

function insertAtCursor(text) {
  var input = $("#chatinput");
  var start = input.selectionStart || 0;
  var before = input.value.substr(0, start);
  var after = input.value.substr(start);
  before += text;
  input.value = before + after;
  input.selectionStart = input.selectionEnd = before.length;
  updateInputSize();
}

function send(data) {
  if (ws && ws.readyState == ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function parseLinks(g0) {
  var a = document.createElement("a");
  a.innerHTML = g0;
  var url = a.textContent;
  a.href = url;
  a.target = "_blank";
  return a.outerHTML;
}

var windowActive = true;
var unread = 0;

window.onfocus = function () {
  windowActive = true;
  updateTitle();
};

window.onblur = function () {
  windowActive = false;
};

window.onscroll = function () {
  if (isAtBottom()) {
    updateTitle();
  }
};

function isAtBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 1;
}

function updateTitle() {
  if (windowActive && isAtBottom()) {
    unread = 0;
  }

  var title;
  if (myChannel) {
    title = "?" + myChannel;
  } else {
    title = "hack.chat";
  }
  if (unread > 0) {
    title = "(" + unread + ") " + title;
  }
  document.title = title;
}

/* footer */

$("#footer").onclick = function () {
  $("#chatinput").focus();
};

$("#chatinput").onkeydown = function (e) {
  if (e.keyCode == 13 /* ENTER */ && !e.shiftKey) {
    e.preventDefault();
    // Submit message
    if (e.target.value != "") {
      var text = e.target.value;
      e.target.value = "";
      send({ cmd: "chat", text: text });
      lastSent[0] = text;
      lastSent.unshift("");
      lastSentPos = 0;
      updateInputSize();
      // 添加这一行来隐藏移动设备键盘
      e.target.blur();
      scrollToBottom();
    }
  } else if (e.keyCode == 38 /* UP */) {
    // Restore previous sent messages
    if (e.target.selectionStart === 0 && lastSentPos < lastSent.length - 1) {
      e.preventDefault();
      if (lastSentPos == 0) {
        lastSent[0] = e.target.value;
      }
      lastSentPos += 1;
      e.target.value = lastSent[lastSentPos];
      e.target.selectionStart = e.target.selectionEnd = e.target.value.length;
      updateInputSize();
    }
  } else if (e.keyCode == 40 /* DOWN */) {
    if (e.target.selectionStart === e.target.value.length && lastSentPos > 0) {
      e.preventDefault();
      lastSentPos -= 1;
      e.target.value = lastSent[lastSentPos];
      e.target.selectionStart = e.target.selectionEnd = 0;
      updateInputSize();
    }
  } else if (e.keyCode == 27 /* ESC */) {
    e.preventDefault();
    // Clear input field
    e.target.value = "";
    lastSentPos = 0;
    lastSent[lastSentPos] = "";
    updateInputSize();
  } else if (e.keyCode == 9 /* TAB */) {
    // Tab complete nicknames starting with @
    e.preventDefault();
    var pos = e.target.selectionStart || 0;
    var text = e.target.value;
    var index = text.lastIndexOf("@", pos);
    if (index >= 0) {
      var stub = text.substring(index + 1, pos).toLowerCase();
      // Search for nick beginning with stub
      var nicks = onlineUsers.filter(function (nick) {
        return nick.toLowerCase().indexOf(stub) == 0;
      });
      if (nicks.length == 1) {
        insertAtCursor(nicks[0].substr(stub.length) + " ");
      }
    }
  }
};

function updateInputSize() {
  var atBottom = isAtBottom();

  var input = $("#chatinput");
  input.style.height = 0;
  input.style.height = input.scrollHeight + "px";
  document.body.style.marginBottom = $("#footer").offsetHeight + "px";

  if (atBottom) {
    window.scrollTo(0, document.body.scrollHeight);
  }
}

$("#chatinput").oninput = function () {
  updateInputSize();
};

// 添加发送按钮点击事件处理
$("#send-button").onclick = function (e) {
  e.preventDefault();
  var input = $("#chatinput");
  var text = input.value;
  if (text != "") {
    input.value = "";
    send({ cmd: "chat", text: text });
    lastSent[0] = text;
    lastSent.unshift("");
    lastSentPos = 0;
    updateInputSize();

    // 强制失去焦点并添加短暂延迟
    input.blur();
    setTimeout(function () {
      input.blur();
      scrollToBottom();
      $("#sidebar-content").classList.remove("hidden");
      $("#sidebar-content").classList.add("hidden");
    }, 100);
  }
};

// 滚动到消息容器最底部的函数
function scrollToBottom() {
  var messagesContainer = $("#messages");
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
}

$("#chatinput").oninput = function () {
  updateInputSize();
};

updateInputSize();

/* sidebar */

$("#sidebar").onmouseenter = $("#sidebar").ontouchstart = function (e) {
  $("#sidebar-content").classList.remove("hidden");
  e.stopPropagation();
};

$("#sidebar").onmouseleave = document.ontouchstart = function () {
  if (!$("#pin-sidebar").checked) {
    $("#sidebar-content").classList.add("hidden");
  }
};

$("#clear-messages").onclick = function () {
  // Delete children elements
  var messages = $("#messages");
  while (messages.firstChild) {
    messages.removeChild(messages.firstChild);
  }
};

// Restore settings from localStorage

if (localStorageGet("pin-sidebar") == "true") {
  $("#pin-sidebar").checked = true;
  $("#sidebar-content").classList.remove("hidden");
}
if (localStorageGet("joined-left") == "false") {
  $("#joined-left").checked = false;
}
if (localStorageGet("parse-latex") == "false") {
  $("#parse-latex").checked = false;
}

$("#pin-sidebar").onchange = function (e) {
  localStorageSet("pin-sidebar", !!e.target.checked);
};
$("#joined-left").onchange = function (e) {
  localStorageSet("joined-left", !!e.target.checked);
};
$("#parse-latex").onchange = function (e) {
  localStorageSet("parse-latex", !!e.target.checked);
};

// User list

var onlineUsers = [];
var ignoredUsers = [];

function userAdd(nick) {
  var user = document.createElement("a");
  user.textContent = nick;
  user.onclick = function (e) {
    userInvite(nick);
  };
  var userLi = document.createElement("li");
  userLi.appendChild(user);
  $("#users").appendChild(userLi);
  onlineUsers.push(nick);
}

function userRemove(nick) {
  var users = $("#users");
  var children = users.children;
  for (var i = 0; i < children.length; i++) {
    var user = children[i];
    if (user.textContent == nick) {
      users.removeChild(user);
    }
  }
  var index = onlineUsers.indexOf(nick);
  if (index >= 0) {
    onlineUsers.splice(index, 1);
  }
}

function usersClear() {
  var users = $("#users");
  while (users.firstChild) {
    users.removeChild(users.firstChild);
  }
  onlineUsers.length = 0;
}

function userInvite(nick) {
  send({ cmd: "invite", nick: nick });
}

function userIgnore(nick) {
  ignoredUsers.push(nick);
}

/* color scheme switcher */

var schemes = [
  "android",
  "atelier-dune",
  "atelier-forest",
  "atelier-heath",
  "atelier-lakeside",
  "atelier-seaside",
  "bright",
  "chalk",
  "default",
  "eighties",
  "greenscreen",
  "mocha",
  "monokai",
  "nese",
  "ocean",
  "pop",
  "railscasts",
  "solarized",
  "tomorrow"
];

var currentScheme = "android";

function setScheme(scheme) {
  currentScheme = scheme;
  $("#scheme-link").href = "/schemes/" + scheme + ".css";
  localStorageSet("scheme", scheme);
}

// Add scheme options to dropdown selector
schemes.forEach(function (scheme) {
  var option = document.createElement("option");
  option.textContent = scheme;
  option.value = scheme;
  $("#scheme-selector").appendChild(option);
});

$("#scheme-selector").onchange = function (e) {
  setScheme(e.target.value);
};

// Load sidebar configaration values from local storage if available
if (localStorageGet("scheme")) {
  setScheme(localStorageGet("scheme"));
}

$("#scheme-selector").value = currentScheme;

/* main */

if (myChannel == "") {
  pushMessage({ text: frontpage });
  $("#footer").classList.add("hidden");
  $("#sidebar").classList.add("hidden");
} else {
  join(myChannel);
}
