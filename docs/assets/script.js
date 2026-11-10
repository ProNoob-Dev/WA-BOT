// Copy buttons for <pre> blocks. No framework, no tracking.
document.querySelectorAll("pre").forEach((pre) => {
  const btn = document.createElement("button");
  btn.className = "copy";
  btn.type = "button";
  btn.textContent = "copy";
  btn.addEventListener("click", async () => {
    const text = pre.querySelector("code")?.innerText ?? pre.innerText;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "copied";
    } catch {
      btn.textContent = "select + copy";
    }
    setTimeout(() => { btn.textContent = "copy"; }, 1500);
  });
  pre.appendChild(btn);
});
