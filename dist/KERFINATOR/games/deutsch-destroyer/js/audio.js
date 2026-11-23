/* Sound effects loaded as separate audio files (relative paths). */
var SFX = (function () {
  var names = ['laser', 'boom', 'alarm'], pool = {};
  names.forEach(function (n) { pool[n] = new Audio('assets/sfx/' + n + '.wav'); pool[n].preload = 'auto'; });
  return {
    play: function (n, vol) {
      var a = pool[n].cloneNode();
      a.volume = vol == null ? 0.5 : vol;
      a.play().catch(function () {});
    },
    ready: function () { return names.every(function (n) { return pool[n].readyState >= 2; }); }
  };
})();
