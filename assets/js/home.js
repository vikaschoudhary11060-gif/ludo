/* Home — promo carousel. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $ } = K;
  K.ready.then(() => {
    const track = $('#carousel-track'), dots = $('#carousel-dots');
    if (!track) return;
    const n = track.children.length;
    let i = 0, timer;
    dots.innerHTML = Array.from({ length: n }, (_, k) =>
      `<button class="h-1.5 rounded-full bg-white/60 transition-all" style="width:${k === 0 ? 18 : 6}px"
               type="button" data-slide="${k}" aria-label="Slide ${k + 1}"></button>`).join('');
    function go(k) {
      i = (k + n) % n;
      track.style.transform = `translateX(-${i * 100}%)`;
      [...dots.children].forEach((d, k2) => {
        d.style.width = k2 === i ? '18px' : '6px';
        d.classList.toggle('bg-white', k2 === i);
        d.classList.toggle('bg-white/60', k2 !== i);
      });
    }
    const play = () => (timer = setInterval(() => go(i + 1), 4500));
    const pause = () => clearInterval(timer);
    dots.addEventListener('click', e => {
      const b = e.target.closest('[data-slide]'); if (b) { pause(); go(+b.dataset.slide); play(); }
    });
    $('#carousel').addEventListener('mouseenter', pause);
    $('#carousel').addEventListener('mouseleave', play);
    go(0); play();
  });
})();
