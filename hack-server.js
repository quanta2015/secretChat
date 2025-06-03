/* jshint asi: true */
/* jshint esnext: true */

var fs = require("fs");
var ws = require("ws");
var crypto = require("crypto");
var express = require("express"); // 添加Express依赖
var path = require("path"); // 添加path模块用于处理文件路径
var http = require("http"); // 添加http模块用于创建HTTP服务器

var config = {};
function loadConfig(filename) {
  try {
    var data = fs.readFileSync(filename, "utf8");
    config = JSON.parse(data);
    console.log("已加载配置文件 '" + filename + "'");
  } catch (e) {
    console.warn(e);
  }
}

var configFilename = "config.json";
loadConfig(configFilename);
fs.watchFile(configFilename, { persistent: false }, function () {
  loadConfig(configFilename);
});

// 创建Express应用
var app = express();

// 设置静态文件目录
app.use(express.static(path.join(__dirname, "client")));

// 添加根路由，确保访问根路径时返回index.html
app.get("/", function (req, res) {
  res.sendFile(path.join(__dirname, "client", "index.html"));
});

// 创建HTTP服务器
var httpServer = http.createServer(app);

// 将WebSocket服务器附加到HTTP服务器
var server = new ws.Server({
  server: httpServer, // 使用HTTP服务器
  verifyClient: (info, cb) => {
    // 可选：在此处添加任何验证逻辑
    cb(true);
  }
});

// 启动HTTP服务器
httpServer.listen(config.port, config.host, function () {
  console.log("服务器已启动，监听地址 " + config.host + ":" + config.port);
});

// 添加send函数定义 - 这是修复错误的关键部分
function send(data, client) {
  // 为命令添加时间戳
  data.time = Date.now();
  try {
    if (client.readyState == ws.OPEN) {
      client.send(JSON.stringify(data));
    }
  } catch (e) {
    // 忽略client.send()抛出的异常
  }
}

// 以下是原有的WebSocket服务器代码
server.on("connection", function (socket, req) {
  socket.upgradeReq = req;

  // Socket接收器崩溃，清空并关闭socket
  socket._receiver.onerror = function (e) {
    socket._receiver.messageBuffer = [];
    socket._receiver.cleanup();
    socket.close();
  };

  socket.on("message", function (data) {
    try {
      // 先不处罚，但检查IP是否被限速
      if (POLICE.frisk(getAddress(socket), 0)) {
        send({ cmd: "warn", text: "您的IP正被限速或封锁。" }, socket);
        return;
      }
      // 在此处罚，但不采取任何措施
      POLICE.frisk(getAddress(socket), 1);

      // 忽略过大的数据包
      if (data.length > 65536) {
        return;
      }
      var args = JSON.parse(data);
      var cmd = args.cmd;
      var command = COMMANDS[cmd];
      if (command && args) {
        command.call(socket, args);
      }
    } catch (e) {
      // Socket发送了格式错误的JSON或缓冲区包含无效JSON
      // 出于安全考虑，应该关闭它
      socket._receiver.messageBuffer = [];
      socket._receiver.cleanup();
      socket.close();
      console.warn(e.stack);
    }
  });

  socket.on("close", function () {
    try {
      if (socket.channel) {
        broadcast({ cmd: "onlineRemove", nick: socket.nick }, socket.channel);
      }
    } catch (e) {
      console.warn(e.stack);
    }
  });
});

/** 向所有客户端发送数据
channel: 如果不为null，则限制广播到指定频道的客户端
*/
function broadcast(data, channel) {
  for (var client of server.clients) {
    if (channel ? client.channel === channel : client.channel) {
      send(data, client);
    }
  }
}

function nicknameValid(nick) {
  // 允许字母、数字和下划线
  return /^[a-zA-Z0-9_]{1,24}$/.test(nick);
}

function getAddress(client) {
  if (config.x_forwarded_for) {
    // 远程地址是127.0.0.1，因为所有连接都来自代理（如nginx）。
    // 必须写入x-forwarded-for头以确定客户端的真实IP地址。
    // return client.upgradeReq.headers['x-forwarded-for']
    return (
      client._socket.remoteAddress || (client.upgradeReq && client.upgradeReq.headers["x-forwarded-for"]) || "unknown"
    );
  } else {
    //return client.upgradeReq.connection.remoteAddress
    return client._socket.remoteAddress || "unknown";
  }
}

function hash(password) {
  var sha = crypto.createHash("sha256");
  sha.update(password + config.salt);
  return sha.digest("base64").substr(0, 6);
}

function isAdmin(client) {
  return client.nick == config.admin;
}

function isMod(client) {
  if (isAdmin(client)) return true;
  if (config.mods) {
    if (client.trip && config.mods.indexOf(client.trip) > -1) {
      return true;
    }
  }
  return false;
}

// `this` 绑定到客户端
var COMMANDS = {
  ping: function () {
    send({ cmd: "pong" }, this); 
  },


  join: function (args) {
    var channel = String(args.channel);
    var nick = String(args.nick);

    if (POLICE.frisk(getAddress(this), 3)) {
      send({ cmd: "warn", text: "您加入频道的速度过快。请稍等片刻再试。" }, this);
      return;
    }

    if (this.nick) {
      // 已加入
      return;
    }

    // 处理频道名称
    channel = channel.trim();
    if (!channel) {
      // 必须加入非空白频道
      return;
    }

    // 处理昵称
    var nickArr = nick.split("#", 2);
    nick = nickArr[0].trim();

    if (!nicknameValid(nick)) {
      send({ cmd: "warn", text: "昵称必须由最多24个字母、数字和下划线组成" }, this);
      return;
    }

    var password = nickArr[1];
    if (nick.toLowerCase() == config.admin.toLowerCase()) {
      if (password != config.password) {
        send({ cmd: "warn", text: "不能冒充管理员" }, this);
        return;
      }
    } else if (password) {
      this.trip = hash(password);
    }

    var address = getAddress(this);
    for (var client of server.clients) {
      if (client.channel === channel) {
        if (client.nick.toLowerCase() === nick.toLowerCase()) {
          send({ cmd: "warn", text: "昵称已被占用" }, this);
          return;
        }
      }
    }

    // 宣布新用户
    broadcast({ cmd: "onlineAdd", nick: nick }, channel);

    // 正式加入频道
    this.channel = channel;
    this.nick = nick;

    // 为新用户设置在线用户列表
    var nicks = [];
    for (var client of server.clients) {
      if (client.channel === channel) {
        nicks.push(client.nick);
      }
    }
    send({ cmd: "onlineSet", nicks: nicks }, this);
  },

  chat: function (args) {
    var text = String(args.text);

    if (!this.channel) {
      return;
    }
    // 去除开头和结尾的换行符
    text = text.replace(/^\s*\n|^\s+$|\n\s*$/g, "");
    // 将3个以上的换行符替换为2个
    text = text.replace(/\n{3,}/g, "\n\n");
    if (!text) {
      return;
    }

    var score = text.length / 83 / 4;
    if (POLICE.frisk(getAddress(this), score)) {
      send(
        {
          cmd: "warn",
          text: "您发送的文本过多。请稍等片刻再试。\n按上箭头键可恢复您最后的消息。"
        },
        this
      );
      return;
    }

    var data = { cmd: "chat", nick: this.nick, text: text };
    if (isAdmin(this)) {
      data.admin = true;
    } else if (isMod(this)) {
      data.mod = true;
    }
    if (this.trip) {
      data.trip = this.trip;
    }
    broadcast(data, this.channel);
  },

  invite: function (args) {
    var nick = String(args.nick);
    if (!this.channel) {
      return;
    }

    if (POLICE.frisk(getAddress(this), 2)) {
      send({ cmd: "warn", text: "您发送邀请的速度过快。请稍等片刻再试。" }, this);
      return;
    }

    var friend;
    for (var client of server.clients) {
      // 查找朋友的客户端
      if (client.channel == this.channel && client.nick == nick) {
        friend = client;
        break;
      }
    }
    if (!friend) {
      send({ cmd: "warn", text: "在频道中找不到用户" }, this);
      return;
    }
    if (friend == this) {
      // 静默忽略
      return;
    }
    var channel = Math.random().toString(36).substr(2, 8);
    send({ cmd: "info", text: "您邀请了 " + friend.nick + " 到 ?" + channel }, this);
    send({ cmd: "info", text: this.nick + " 邀请您到 ?" + channel }, friend);
  },

  stats: function (args) {
    var ips = {};
    var channels = {};
    for (var client of server.clients) {
      if (client.channel) {
        channels[client.channel] = true;
        ips[getAddress(client)] = true;
      }
    }
    send(
      { cmd: "info", text: Object.keys(ips).length + " 个唯一IP在 " + Object.keys(channels).length + " 个频道中" },
      this
    );
  },

  // 以下为仅限管理员的命令

  ban: function (args) {
    if (!isMod(this)) {
      return;
    }

    var nick = String(args.nick);
    if (!this.channel) {
      return;
    }

    var badClient = server.clients.filter(function (client) {
      return client.channel == this.channel && client.nick == nick;
    }, this)[0];

    if (!badClient) {
      send({ cmd: "warn", text: "找不到 " + nick }, this);
      return;
    }

    if (isMod(badClient)) {
      send({ cmd: "warn", text: "不能封禁管理员" }, this);
      return;
    }

    POLICE.arrest(getAddress(badClient));
    console.log(this.nick + " [" + this.trip + "] 在 " + this.channel + " 封禁了 " + nick);
    broadcast({ cmd: "info", text: "已封禁 " + nick }, this.channel);
  },

  unban: function (args) {
    if (!isMod(this)) {
      return;
    }

    var ip = String(args.ip);
    if (!this.channel) {
      return;
    }

    POLICE.pardon(ip);
    console.log(this.nick + " [" + this.trip + "] 在 " + this.channel + " 解封了 " + ip);
    send({ cmd: "info", text: "已解封 " + ip }, this);
  },

  // 以下为仅限管理员的命令

  listUsers: function () {
    if (!isAdmin(this)) {
      return;
    }
    var channels = {};
    for (var client of server.clients) {
      if (client.channel) {
        if (!channels[client.channel]) {
          channels[client.channel] = [];
        }
        channels[client.channel].push(client.nick);
      }
    }

    var lines = [];
    for (var channel in channels) {
      lines.push("?" + channel + " " + channels[channel].join(", "));
    }
    var text = server.clients.length + " 个用户在线:\n\n";
    text += lines.join("\n");
    send({ cmd: "info", text: text }, this);
  },

  broadcast: function (args) {
    if (!isAdmin(this)) {
      return;
    }
    var text = String(args.text);
    broadcast({ cmd: "info", text: "服务器广播: " + text });
  }
};

// 速率限制器
var POLICE = {
  records: {},
  halflife: 30000, // 毫秒
  threshold: 15,

  loadJail: function (filename) {
    var ids;
    try {
      var text = fs.readFileSync(filename, "utf8");
      ids = text.split(/\r?\n/);
    } catch (e) {
      return;
    }
    for (var id of ids) {
      if (id && id[0] != "#") {
        this.arrest(id);
      }
    }
    console.log("已加载封禁列表 '" + filename + "'");
  },

  search: function (id) {
    var record = this.records[id];
    if (!record) {
      record = this.records[id] = {
        time: Date.now(),
        score: 0
      };
    }
    return record;
  },

  frisk: function (id, deltaScore) {
    var record = this.search(id);
    if (record.arrested) {
      return true;
    }

    record.score *= Math.pow(2, -(Date.now() - record.time) / POLICE.halflife);
    record.score += deltaScore;
    record.time = Date.now();
    if (record.score >= this.threshold) {
      return true;
    }
    return false;
  },

  arrest: function (id) {
    var record = this.search(id);
    if (record) {
      record.arrested = true;
    }
  },

  pardon: function (id) {
    var record = this.search(id);
    if (record) {
      record.arrested = false;
    }
  }
};

POLICE.loadJail("jail.txt");
