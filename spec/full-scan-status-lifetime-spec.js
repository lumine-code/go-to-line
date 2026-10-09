describe("go-to-line full-scan status service lifetime", () => {
  let main, hub, consumer, bars, providers, StatusBarView;
  const tiles = (bar) =>
    [...bar.getLeftTiles(), ...bar.getRightTiles()].filter((tile) =>
      tile.getItem().matches?.(".editor-position"),
    );
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("status-bar");
    main = (await lumine.packages.activatePackage("go-to-line")).mainModule;
    StatusBarView = lumine.packages.getActivePackage("status-bar").mainModule.statusBar.constructor;
    await lumine.workspace.open();
    hub = new lumine.packages.serviceHub.constructor();
    consumer = hub.consume("status-bar", "^1.0.0", (bar) => main.consumeStatusBar(bar));
    bars = [];
    providers = [];
  });
  afterEach(async () => {
    consumer.dispose();
    for (const provider of providers) provider.dispose();
    await lumine.packages.deactivatePackage("go-to-line");
    for (const bar of bars) {
      for (const tile of tiles(bar)) tile.destroy();
      bar.destroy();
    }
  });
  const provide = (bar = null) => {
    if (!bar) {
      bar = new StatusBarView();
      bars.push(bar);
      jasmine.attachToDOM(bar.element);
    }
    const provider = hub.provide("status-bar", "1.0.0", bar);
    providers.push(provider);
    return { bar, provider };
  };
  it("shares identical service payloads until the final registration is withdrawn", async () => {
    const first = provide(),
      second = provide(first.bar);
    await Promise.resolve();
    expect(tiles(first.bar).length).toBe(1);
    first.provider.dispose();
    expect(tiles(first.bar).length).toBe(1);
    second.provider.dispose();
    expect(tiles(first.bar).length).toBe(0);
  });
  it("retires every manually connected provider on package deactivation", async () => {
    const first = provide(),
      second = provide();
    await Promise.resolve();
    await lumine.packages.deactivatePackage("go-to-line");
    expect(tiles(first.bar).length).toBe(0);
    expect(tiles(second.bar).length).toBe(0);
  });
  it("keeps a later activation's exact same-payload tile alive when the old provider is withdrawn", async () => {
    const old = provide();
    await Promise.resolve();
    await lumine.packages.deactivatePackage("go-to-line");
    main = (await lumine.packages.activatePackage("go-to-line")).mainModule;
    const current = provide(old.bar);
    await Promise.resolve();
    old.provider.dispose();
    expect(tiles(current.bar).length).toBe(1);
    current.provider.dispose();
    expect(tiles(current.bar).length).toBe(0);
  });

  it("cleans staged position views when tile creation reenters package deactivation", async () => {
    const bar = new StatusBarView();
    bars.push(bar);
    const add = bar.addLeftTile.bind(bar);
    let staged;
    spyOn(bar, "addLeftTile").and.callFake((options) => {
      staged = options.item;
      const tile = add(options);
      main.deactivate();
      return tile;
    });
    const lease = main.consumeStatusBar(bar);
    await Promise.resolve();
    expect(tiles(bar).length).toBe(0);
    expect(lumine.tooltips.findTooltips(staged)).toEqual([]);
    lease.dispose();
  });

  it("applies visibility configuration once to every distinct live bar", async () => {
    const first = provide(),
      second = provide();
    await Promise.resolve();
    lumine.config.set("go-to-line.showInStatusBar", false);
    expect(tiles(first.bar).length).toBe(0);
    expect(tiles(second.bar).length).toBe(0);
    lumine.config.set("go-to-line.showInStatusBar", true);
    expect(tiles(first.bar).length).toBe(1);
    expect(tiles(second.bar).length).toBe(1);
    lumine.config.unset("go-to-line.showInStatusBar");
  });

  it("does not destroy a replacement prompt created while an old tile is disposed", async () => {
    const oldHost = main.activate().inputDialogHost;
    const entry = provide();
    await Promise.resolve();
    const tile = tiles(entry.bar)[0],
      destroy = tile.destroy.bind(tile);
    let currentHost, currentLease;
    spyOn(tile, "destroy").and.callFake(() => {
      const current = main.activate();
      current.open();
      currentHost = current.inputDialogHost;
      currentLease = main.consumeStatusBar(entry.bar);
      destroy();
    });
    main.deactivate();
    await Promise.resolve();
    expect(currentHost).not.toBe(oldHost);
    expect(currentHost.isVisible()).toBe(true);
    expect(tiles(entry.bar).length).toBe(1);
    currentLease.dispose();
  });

  for (const restore of [false, true]) {
    it(`does not publish an obsolete tile when creation changes visibility with restore=${restore}`, async () => {
      const bar = new StatusBarView();
      bars.push(bar);
      const add = bar.addLeftTile.bind(bar);
      let changed = false;
      spyOn(bar, "addLeftTile").and.callFake((options) => {
        const tile = add(options);
        if (!changed) {
          changed = true;
          lumine.config.set("go-to-line.showInStatusBar", false);
          if (restore) lumine.config.set("go-to-line.showInStatusBar", true);
        }
        return tile;
      });
      const lease = main.consumeStatusBar(bar);
      await Promise.resolve();
      expect(tiles(bar).length).toBe(restore ? 1 : 0);
      lease.dispose();
      expect(tiles(bar).length).toBe(0);
      lumine.config.unset("go-to-line.showInStatusBar");
    });
  }
});
