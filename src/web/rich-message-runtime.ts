/**
 * Patchouli Knowledge - 富消息元素渲染运行时（vanilla DOM，零 HTML 字符串拼接）
 *
 * 与 `traffic-runtime.ts` 同属一份字符串运行时：独立页面 / 悬浮坞把它与流量更新器一起内联，
 * `scripts/sync-traffic-client.cjs` 生成的 Console 片段同样整段复用，三端行为完全一致。
 * 只依赖宿主提供的 `monitorViewport()` 与全局 `document` / `window`，不需要任何额外 helper 注入。
 *
 * 元素契约（`LatestMessage.elements[]`，与 OneBot WebQQ 的 `WebQQMessageElement` 对齐）：
 *   type: 'text' | 'image' | 'quote' | 'forward' | 'card' | 'face' | 'file' | 'record' | 'video' | 'unknown'
 *   字段: text / title / url / imageUrl / emojiUrl / source / targetMessageId / duration / items
 *   `items` 为合并转发条目：`{ title?, elements[] }[]`，递归渲染（深度上限 3 层）。
 *
 * 红线：
 * - 全部节点经 `document.createElement` / `textContent` 构造，绝不拼接 HTML、绝不触碰
 *   `innerHTML` / `eval` / `iframe`；用户消息文本永远只作为文本节点落地。
 * - 媒体地址有两种形态，后端保证都是浏览器可直接加载的地址：
 *   ① 公网直链 `https://multimedia.nt.qq.com.cn/…` / `https://gchat.qpic.cn/…`；
 *   ② http 源或非直链 scheme 走同源代理相对路径 `<页面 basePath>/api/media/<32hex>`。
 *   两者都先经 `new URL(raw, location.href)` 解析，只放行 `http:` / `https:`；
 *   `javascript:` / `data:` / `file:` 等一律降级为纯文本占位。外链一律 `noopener noreferrer`。
 * - 图片 / 视频 / 语音一律 `referrerpolicy="no-referrer"`，加载失败（含媒体代理 404「已过期」）
 *   就用可见文本替换失败节点，绝不留空白或假图。
 * - 音频 / 视频只带 `controls`，永不 `autoplay`，`preload` 分别取 `none` / `metadata`。
 * - 同一条消息（id + elements 指纹不变）绝不重建 DOM：正在播放、已展开的合并转发不会被
 *   5 秒轮询打断；只有新消息（id / 指纹变化）才替换预览内容。指纹与渲染共用同一组上限
 *   （单层 60 个元素、单个转发 20 条、递归 3 层），渲染出来的内容变化必然进入指纹。
 * - DOM 体量硬上限：任何一层超出 60 个元素只渲染前 60 个 + 一句「另有 N 段内容未展开」，
 *   恶意超量 AST 不会被等量放大成 DOM。
 * - 图片放大走原生 `<dialog>`（Esc 关闭、点空白处关闭），零自定义弹层、零按钮形变。
 */
export function richMessageRuntime(): string {
  return String.raw`
  /* 合并转发递归深度上限：超过即降级为折叠摘要，杜绝恶意深层嵌套拖垮渲染。 */
  var RICH_FORWARD_DEPTH = 3;
  /* 单个合并转发最多就地渲染的条目数（其余只报数量，不展开）。 */
  var RICH_FORWARD_ITEMS = 20;
  /* 单次渲染的元素上限（与后端顶层 elements 上限 60 一致）：任何一层都不允许超量 AST 膨胀成等量 DOM。 */
  var RICH_ELEMENT_LIMIT = 60;

  function richText(value) {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    return String(value);
  }

  /* URL 白名单：只放行 http / https；相对路径按当前页面解析后同样归入 http(s)。 */
  function richUrl(raw) {
    var text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return "";
    try {
      var url = new URL(text, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.href;
    } catch (error) {
      return "";
    }
  }

  function richLabel(element, fallback) {
    var text = richText(element && element.text).trim();
    if (text) return text;
    var title = richText(element && element.title).trim();
    return title || fallback;
  }

  function richCreate(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function richSpan(className, text) {
    var node = richCreate("span", className);
    node.textContent = text;
    return node;
  }

  function richLink(href, className, text) {
    var node = richCreate("a", className);
    node.setAttribute("href", href);
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
    node.textContent = text;
    return node;
  }

  function richImage(url, className, alt) {
    var image = document.createElement("img");
    if (className) image.className = className;
    image.setAttribute("src", url);
    image.setAttribute("alt", alt || "");
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
    image.setAttribute("referrerpolicy", "no-referrer");
    return image;
  }

  /* 图片 / 视频 / 语音加载失败（直链失效、代理 404「媒体已过期」）→ 可见文本，绝不留空白。 */
  function richFail(node, label) {
    if (node && node.parentNode) node.parentNode.replaceChild(richSpan("ptx-rich-text ptx-rich-failed", label), node);
  }

  /* 把失败兜底挂到真正抛 error 的节点（media 的 error 事件不冒泡），替换掉 target。 */
  function richGuard(node, target, label) {
    node.addEventListener("error", function () {
      richFail(target || node, label);
    });
    return node;
  }

  /* 语音时长：秒 → m:ss；非正数 / 非数字返回空串（不占位）。 */
  function richClock(seconds) {
    var total = Math.round(Number(seconds));
    if (!isFinite(total) || total <= 0) return "";
    var minutes = Math.floor(total / 60);
    var rest = total - minutes * 60;
    return minutes + ":" + (rest < 10 ? "0" + rest : String(rest));
  }

  /* ---------------- 图片放大：原生 dialog（Esc / 点空白关闭） ---------------- */

  /* 弹窗宿主：dialog 必须挂在有机根容器上，绝不能留在 .ptx-viewport 里。
     版心规则（.ptx-viewport > :not(dialog)）虽然已排除 dialog，但只要它还留在视窗内，
     就会继续被视窗的内容流、裁剪上下文与背景层包住，任何一条宿主继承下来的宽容规则
     （宽度 / 外边距）都能改写它的几何，全屏居中无从谈起。挂到根容器后它与窗口同级，
     尺寸与位置完全由自己的 fixed + inset: 0 + margin: auto 决定。 */
  function richLightboxHost() {
    var root = document.getElementById("patchouli-organic-root");
    if (root) return root;
    /* 内嵌面板 / 独立页没有这个 id：沿视窗向上取挂在 body 下的最外层有机容器
       （内嵌面板即 #ptxDockRoot），dialog 既脱出版心，又留在样式令牌与
       .ptx-rich-lightbox 规则的作用域内——直接挂 body 会丢掉全部令牌。 */
    var origin = monitorViewport();
    var node = origin;
    while (node && node.parentElement && node.parentElement !== document.body) node = node.parentElement;
    if (!node || node === origin || !node.parentElement) return document.body;
    return node;
  }

  function richLightbox() {
    var host = richLightboxHost();
    var dialog = host.querySelector("dialog.ptx-rich-lightbox");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.className = "ptx-rich-lightbox";
    dialog.setAttribute("aria-label", "图片预览");
    var image = document.createElement("img");
    image.setAttribute("alt", "图片预览");
    image.setAttribute("decoding", "async");
    image.setAttribute("referrerpolicy", "no-referrer");
    dialog.appendChild(image);
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog && dialog.open) dialog.close();
    });
    host.appendChild(dialog);
    return dialog;
  }

  function richOpenImage(url) {
    if (!url) return;
    var dialog = richLightbox();
    var image = dialog.querySelector("img");
    if (image && image.getAttribute("src") !== url) image.setAttribute("src", url);
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
      return;
    }
    dialog.setAttribute("open", "open");
  }

  /* ---------------- 单元素渲染 ---------------- */

  function richTextNode(element) {
    var text = richText(element.text);
    if (!text) return null;
    return richSpan("ptx-rich-text", text);
  }

  function richFaceNode(element) {
    var emoji = richUrl(element.emojiUrl);
    var label = richText(element.text).trim() || "表情";
    if (!emoji) return richSpan("ptx-rich-text", label);
    var image = richImage(emoji, "ptx-rich-face", label);
    image.setAttribute("loading", "eager");
    return richGuard(image, image, label);
  }

  function richImageNode(element) {
    var url = richUrl(element.url);
    if (!url) return richSpan("ptx-rich-text", richLabel(element, "[图片]"));
    var button = richCreate("button", "ptx-rich-image");
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", "查看大图");
    /* 后端把 image 元素的 text 归一成人读标签（如「[图片]」），有 url 时用作 alt，无 url 时才是正文。 */
    button.appendChild(richGuard(richImage(url, "", richText(element.text).trim() || "图片"), button, "图片加载失败"));
    button.addEventListener("click", function () {
      richOpenImage(url);
    });
    return button;
  }

  /* 视频：封面（有直链时直接当 poster）+ 标题 + 合法外链 + 原生 controls，绝不自动播放。 */
  function richVideoNode(element) {
    var url = richUrl(element.url);
    var poster = richUrl(element.imageUrl);
    var title = richText(element.title).trim() || richText(element.text).trim();
    if (!url) {
      if (!poster) return richSpan("ptx-rich-text", richLabel(element, "[视频]"));
      var coverOnly = richCreate("div", "ptx-rich-media-card");
      coverOnly.appendChild(richGuard(richImage(poster, "ptx-rich-cover", title || richText(element.text).trim() || "视频封面"), null, "封面加载失败"));
      if (title) coverOnly.appendChild(richSpan("ptx-rich-media-title", title));
      return coverOnly;
    }
    var card = richCreate("div", "ptx-rich-media-card");
    if (title) card.appendChild(richSpan("ptx-rich-media-title", title));
    var player = document.createElement("video");
    player.className = "ptx-rich-video-player";
    player.setAttribute("controls", "controls");
    player.setAttribute("preload", "metadata");
    player.setAttribute("playsinline", "playsinline");
    player.setAttribute("referrerpolicy", "no-referrer");
    player.setAttribute("src", url);
    if (poster) {
      player.setAttribute("poster", poster);
      /* 封面失效时摘掉 poster，让原生播放器回落到首帧，而不是留一块空白海报位。 */
      var probe = new Image();
      probe.addEventListener("error", function () {
        player.removeAttribute("poster");
      });
      probe.src = poster;
    }
    richGuard(player, player, "视频加载失败（可能已失效或未登记）");
    card.appendChild(player);
    card.appendChild(richLink(url, "ptx-rich-link", "在新窗口打开视频"));
    return card;
  }

  function richCardNode(element) {
    var url = richUrl(element.url);
    var cover = richUrl(element.imageUrl);
    var title = richText(element.title).trim();
    var text = richText(element.text).trim();
    var source = richText(element.source).trim();
    if (!cover && !title && !text && !source) return richSpan("ptx-rich-text", "[卡片消息]");
    var node = richCreate(url ? "a" : "div", "ptx-rich-card");
    if (url) {
      node.setAttribute("href", url);
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (cover) node.appendChild(richGuard(richImage(cover, "ptx-rich-cover", title || richText(element.text).trim() || "卡片封面"), null, "封面加载失败"));
    var body = richCreate("div", "ptx-rich-card-body");
    if (title) body.appendChild(richSpan("ptx-rich-card-title", title));
    if (text) body.appendChild(richSpan("ptx-rich-card-text", text));
    if (source) body.appendChild(richSpan("ptx-rich-card-source", source));
    node.appendChild(body);
    return node;
  }

  function richQuoteNode(element) {
    var node = richCreate("div", "ptx-rich-quote");
    var title = richText(element.title).trim();
    if (title) node.appendChild(richSpan("ptx-rich-quote-title", title));
    node.appendChild(richSpan("ptx-rich-quote-text", richText(element.text).trim() || "[引用消息]"));
    var target = richText(element.targetMessageId).trim();
    if (target) node.setAttribute("data-target-message", target);
    return node;
  }

  function richForwardItem(item, depth) {
    var node = richCreate("div", "ptx-rich-forward-item");
    var title = richText(item && item.title).trim();
    if (title) node.appendChild(richSpan("ptx-rich-forward-author", title));
    var line = richCreate("div", "ptx-rich-line");
    richAppendChildren(line, item && item.elements, depth);
    if (!line.firstChild) line.textContent = "[空消息]";
    node.appendChild(line);
    return node;
  }

  /* 合并转发：折叠态只报标题与条数，展开后就地推挤但内部细滚动，绝不撑满监控视窗。 */
  function richForwardNode(element, depth) {
    var items = Array.isArray(element.items) ? element.items : [];
    var title = richText(element.title).trim() || "合并转发";
    if (!items.length || depth >= RICH_FORWARD_DEPTH) {
      var flat = richCreate("div", "ptx-rich-quote");
      flat.appendChild(richSpan("ptx-rich-quote-title", title));
      flat.appendChild(richSpan("ptx-rich-quote-text", richText(element.text).trim() || "[合并转发]"));
      return flat;
    }
    var details = richCreate("details", "ptx-rich-forward");
    var summary = richCreate("summary", "ptx-rich-forward-summary");
    summary.appendChild(richSpan("ptx-rich-forward-title", title));
    summary.appendChild(richSpan("ptx-rich-forward-count", "共 " + items.length + " 条"));
    details.appendChild(summary);
    var body = richCreate("div", "ptx-rich-forward-body");
    var limit = Math.min(items.length, RICH_FORWARD_ITEMS);
    for (var index = 0; index < limit; index += 1) body.appendChild(richForwardItem(items[index], depth + 1));
    if (items.length > limit) body.appendChild(richSpan("ptx-rich-forward-more", "另有 " + (items.length - limit) + " 条未展开"));
    details.appendChild(body);
    return details;
  }

  function richFileNode(element) {
    var url = richUrl(element.url);
    var name = richText(element.title).trim() || richText(element.text).trim() || "文件";
    var node = richCreate("div", "ptx-rich-file");
    node.appendChild(richSpan("ptx-rich-file-name", name));
    if (url) {
      var link = richLink(url, "ptx-rich-link", "下载 / 打开");
      link.setAttribute("download", "");
      node.appendChild(link);
    }
    return node;
  }

  function richRecordNode(element) {
    var url = richUrl(element.url);
    var node = richCreate("div", "ptx-rich-record");
    if (url) {
      var audio = document.createElement("audio");
      audio.className = "ptx-rich-audio";
      audio.setAttribute("controls", "controls");
      audio.setAttribute("preload", "none");
      audio.setAttribute("referrerpolicy", "no-referrer");
      audio.setAttribute("src", url);
      node.appendChild(richGuard(audio, audio, "语音加载失败（可能已失效或未登记）"));
    }
    node.appendChild(richSpan("ptx-rich-record-label", richClock(element.duration) || richText(element.text).trim() || "语音"));
    return node;
  }

  function richElementNode(element, depth) {
    if (!element || typeof element !== "object") return null;
    var type = richText(element.type);
    if (type === "text") return richTextNode(element);
    if (type === "face") return richFaceNode(element);
    if (type === "image") return richImageNode(element);
    if (type === "video") return richVideoNode(element);
    if (type === "card") return richCardNode(element);
    if (type === "quote") return richQuoteNode(element);
    if (type === "forward") return richForwardNode(element, depth);
    if (type === "file") return richFileNode(element);
    if (type === "record") return richRecordNode(element);
    return richSpan("ptx-rich-text", richLabel(element, "[未知消息]"));
  }

  /* 元素数量硬上限：超出部分只留一句可见提示，绝不逐条建 DOM（防恶意超量 AST）。 */
  function richAppendChildren(container, elements, depth) {
    if (!Array.isArray(elements)) return;
    var limit = Math.min(elements.length, RICH_ELEMENT_LIMIT);
    for (var index = 0; index < limit; index += 1) {
      var node = richElementNode(elements[index], depth);
      if (node) container.appendChild(node);
    }
    if (elements.length > limit) {
      container.appendChild(richSpan("ptx-rich-text", "另有 " + (elements.length - limit) + " 段内容未展开"));
    }
  }

  /* ---------------- 最新消息横条：指纹不变则一个节点都不动 ---------------- */

  /* 指纹与渲染上限严格对齐：凡是不参与渲染的元素也不必参与比对，凡是渲染出来的内容变化必须被看见。 */
  function richElementsKey(elements, depth) {
    if (!Array.isArray(elements)) return "";
    var parts = [];
    var limit = Math.min(elements.length, RICH_ELEMENT_LIMIT);
    for (var index = 0; index < limit; index += 1) {
      var element = elements[index] && typeof elements[index] === "object" ? elements[index] : {};
      var items = Array.isArray(element.items) ? element.items : [];
      var nested = "";
      if (items.length && depth < 2) {
        var nestedParts = [];
        var nestedLimit = Math.min(items.length, RICH_FORWARD_ITEMS);
        for (var inner = 0; inner < nestedLimit; inner += 1) {
          nestedParts.push(richElementsKey(items[inner] && items[inner].elements, depth + 1));
        }
        nested = nestedParts.join("/");
      }
      parts.push([element.type, element.text, element.title, element.url, element.imageUrl, element.emojiUrl, element.source, element.targetMessageId, element.duration, items.length, nested].join("\u0001"));
    }
    return parts.length + "|" + parts.join("\u0002");
  }

  function richMessageKey(message) {
    if (!message) return "none";
    var elements = Array.isArray(message.elements) ? message.elements : null;
    return richText(message.id) + "#" + richElementsKey(elements, 0) + "#" + richText(message.content).length;
  }

  /**
   * 渲染当前群最新消息。
   *
   * 指纹（id + elements 结构 + 文本长度）与容器上记录的一致时**直接返回**：正在播放的语音 /
   * 视频、已展开的合并转发、已放大或正在加载的图片都不会被 5 秒轮询重建。只有新消息到达
   * （指纹变化）或视图被重新渲染（新容器没有指纹）时才替换内容。
   */
  function renderLatestMessage(message) {
    var root = monitorViewport();
    var body = root ? root.querySelector("[data-message-body]") : null;
    if (!body) return;
    var key = richMessageKey(message);
    if (body.dataset.richKey === key) return;
    body.dataset.richKey = key;
    while (body.firstChild) body.removeChild(body.firstChild);
    if (!message) {
      body.textContent = "等待当前群的新消息";
      return;
    }
    richAppendChildren(body, message.elements, 0);
    if (!body.firstChild) body.textContent = richText(message.content).trim() || "[无文本内容]";
  }

  /* 切换群聊 / 连接中断：清掉指纹并回到空态，避免把上一个群的消息留在横条上。 */
  function resetLatestMessage() {
    var root = monitorViewport();
    var body = root ? root.querySelector("[data-message-body]") : null;
    if (body) body.dataset.richKey = "";
    renderLatestMessage(null);
  }
`;
}
