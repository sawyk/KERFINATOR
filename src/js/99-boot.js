/* Entry point: the same file is the launcher and, with ?play=<id>, a game tab. */
(function () {
  var params = new URLSearchParams(location.search);
  if (params.has('play')) {
    K.player.run(params).catch(function (e) {
      console.error(e);
      K.player.fail('This game could not be started', (e && e.message) || String(e));
    });
  } else {
    K.app.start().catch(function (e) { console.error(e); });
  }
})();
