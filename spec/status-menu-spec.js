describe("go-to-line status action menu", () => {
  let editor;
  const tile = () => lumine.workspace.getElement().querySelector(".editor-position");
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    await lumine.packages.activatePackage("go-to-line");
    editor = await lumine.workspace.open();
    editor.setText("first\nsecond\n");
    await conditionPromise(() => tile() && tile().style.display !== "none");
    await lumine.views.getNextUpdatePromise();
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("go-to-line");
  });

  it("offers the primary mouse action and ignores right button clicks", () => {
    const element = tile();
    expect(element.hasAttribute("data-context-menu-boundary")).toBe(true);
    const commands = lumine.contextMenu.templateForElement(element).map((item) => item.command);
    expect(commands).toContain("go-to-line:toggle");
    const [tooltip] = lumine.tooltips.findTooltips(element);
    expect(tooltip.getTitle()).toContain("Click to");
    expect(tooltip.getTitle()).not.toContain("tooltip-composite");
    const dispatch = spyOn(lumine.commands, "dispatch");
    element.dispatchEvent(new MouseEvent("click", { button: 2, bubbles: true }));
    lumine.contextMenu.templateForElement(element);
    expect(dispatch).not.toHaveBeenCalled();
    element.click();
    expect(dispatch).toHaveBeenCalledOnceWith(editor.getElement(), "go-to-line:toggle");
  });

  it("retires the tile click handler and its menu on deactivation", async () => {
    const element = tile();
    await lumine.packages.deactivatePackage("go-to-line");
    const dispatch = spyOn(lumine.commands, "dispatch");
    element.click();
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      lumine.contextMenu.templateForElement(element).map((item) => item.command),
    ).not.toContain("go-to-line:toggle");
  });

  it("describes the tile's click target in its tooltip and saved focus in its menu", () => {
    const element = tile();
    const [tooltip] = lumine.tooltips.findTooltips(element);
    const button = document.createElement("button");
    lumine.workspace.getElement().append(button);
    try {
      editor.getElement().focus();
      expect(tooltip.getTitle()).toContain("key-binding");
      expect(lumine.contextMenu.templateForElement(element)[0].keyBindingLabel).toBeTruthy();
      button.focus();
      expect(tooltip.getTitle()).toContain("key-binding");
      expect(lumine.contextMenu.templateForElement(element)[0].keyBindingLabel).toBeUndefined();
      expect(tooltip.options.keyBindingTarget()).toBe(editor.getElement());
    } finally {
      button.remove();
    }
  });
});
