/**
 * 设置页逻辑。
 *
 * MV3 的扩展页面禁止内联脚本，所以必须单独一个文件 —— 这也是这里
 * 一个 addEventListener 都没有写在 HTML 上的原因。
 */
(() => {
  "use strict";

  /**
   * getElementById 返回 `HTMLElement | null`，且是泛型擦除的。
   * 这里断言成具体元素类型 —— 元素 id 来自我们自己的 options.html，
   * 逐个再写一遍运行时判空只会把 HTML 和 JS 的绑定检查推后到用户点击时。
   *
   * @param {string} id
   * @returns {HTMLInputElement}
   */
  const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

  /** @param {string} id @returns {HTMLButtonElement} */
  const button = (id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));

  const backendUrlInput = input("backendUrl");
  const collectTokenInput = input("collectToken");
  const status = /** @type {HTMLElement} */ (document.getElementById("status"));

  /**
   * 统一的反馈出口。成功/失败用不同颜色，别让用户盯着绿字看错误
   *
   * @param {string} text
   * @param {string} [kind]
   * @returns {void}
   */
  const show = (text, kind = "") => {
    status.textContent = text;
    status.className = kind;
  };

  /**
   * @param {any} message
   * @returns {Promise<any>}
   */
  const send = (message) => chrome.runtime.sendMessage(message);

  /* 回填已存配置 */
  send({ type: "getSettings" })
    .then((response) => {
      if (!response?.ok) {
        show(response?.error ?? "读取配置失败", "err");
        return;
      }
      backendUrlInput.value = response.settings.backendUrl;
      collectTokenInput.value = response.settings.collectToken;
    })
    .catch((error) => show(`读取配置失败: ${String(error?.message ?? error)}`, "err"));

  button("save").addEventListener("click", async () => {
    show("保存中…");
    const response = await send({
      type: "saveSettings",
      backendUrl: backendUrlInput.value,
      collectToken: collectTokenInput.value,
    });

    if (!response?.ok) {
      show(response?.error ?? "保存失败", "err");
      return;
    }

    // 回填归一化后的地址，让用户看到存进去的到底是什么（末尾斜杠会被去掉）
    backendUrlInput.value = response.settings.backendUrl;
    show("已保存。回到 1688 商品页刷新即可生效。", "ok");
  });

  button("test").addEventListener("click", async () => {
    // 先存再测：测的是输入框里的地址，不是存过的旧地址
    await send({
      type: "saveSettings",
      backendUrl: backendUrlInput.value,
      collectToken: collectTokenInput.value,
    });

    show("测试中…");
    const response = await send({ type: "testConnection", backendUrl: backendUrlInput.value });
    show(response?.ok ? response.message : (response?.error ?? "测试失败"), response?.ok ? "ok" : "err");
  });
})();
