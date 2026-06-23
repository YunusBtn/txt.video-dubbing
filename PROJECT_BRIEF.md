# PROJE: YouTube + Udemy için Profesyonel Çoklu Dil → Türkçe Dublaj Uzantısı

## Genel Amaç

YouTube ve Udemy'de oynatılan videoların altyazılarını (hangi dilde olursa olsun)
gerçek zamanlı olarak yakala, DeepL ile Türkçeye çevir, ve videonun oynatma hızına
tam senkronize şekilde Türkçe sesle dublaj yap. Senkron hatası, cümle kaybı veya
ani kesme OLMAMALI. Teknik terimler İngilizce/orijinal okunuşuyla seslendirilmeli.

## Platform

Chrome MV3 uzantısı. Sadece YouTube (youtube.com) ve Udemy (udemy.com) hedeflenir.
İki platform için ayrı caption-yakalama stratejileri olacak (aşağıda detaylı).

---

## 1. Altyazı Yakalama Stratejisi

### YouTube
- YouTube'un kendi caption render mekanizması var (`.ytp-caption-segment`
  veya benzeri DOM elementleri) — bunlar `video.textTracks` üzerinden de
  erişilebilir olabilir ama YouTube player'ı genelde kendi caption track'ini
  `track.mode = "hidden"` yapıp DOM'a render eder.
- Strateji: önce `video.textTracks` dene (varsa `cuechange` event'i dinle,
  bu en güvenilir kaynak). Yoksa veya boşsa DOM tabanlı caption polling'e düş.
- YouTube'un caption dili HERHANGİ bir dil olabilir (kullanıcının seçtiği
  altyazı dili). Kaynak dili sabit kodlamayın, DeepL'in auto-detect
  (`source_lang` boş bırakma) özelliğini kullanın.
- YouTube SPA (single page app) olduğu için URL değişimlerini (video geçişi)
  `yt-navigate-finish` event'i veya `history.pushState` override ile yakalayın,
  her video geçişinde session'ı temiz şekilde sıfırlayın.

### Udemy
- Önceki projeden bilinen yapı: `video.textTracks` öncelikli, DOM-caption
  fallback ikincil. Shadow DOM olasılığına karşı deep query gerekir.
- Hardcoded class/id selector kullanmayın (Udemy DOM'u değişebilir);
  generic skorlama algoritmasıyla video ve caption elementini bul.

### Ortak Mimari
- Her iki platform için de modüler bir `captionSource` interface'i tasarlayın:
  `{ getActiveCue(), onCueChange(callback), getNextCue(afterCue) }`
- Platform tespiti `location.hostname` ile yapılır, ona göre doğru
  captionSource implementasyonu seçilir.

---

## 2. Çeviri (DeepL)

- Kaynak dil: OTOMATIK TESPİT (DeepL `source_lang` parametresini boş geçin,
  DeepL kendi tespit eder). Kullanıcı manuel dil de seçebilsin (ayarlarda
  "Otomatik" veya dil listesi).
- Hedef dil: Türkçe (sabit, TR).
- Çeviri önbelleği: aynı metin tekrar gelirse (loop/rewind) yeniden API
  çağrısı yapma, cache'den dön.
- Teknik terim koruma: Çeviriye göndermeden önce kullanıcı tanımlı terimleri
  placeholder'a çevir (örn. `{{TERM_0}}`), çeviri sonrası geri koy. Böylece
  "backend", "REST API", "Spring Boot" gibi terimler yanlış çevrilmez.
- Çeviri API hata/timeout durumunda: 3 saniye içinde cevap gelmezse o segmenti
  atla, kullanıcıyı overlay'de "çeviri gecikti" notuyla bilgilendir, akışı
  bloklamadan devam et.

---

## 3. Senkron Mimarisi — KRİTİK BÖLÜM

Bu projenin en önemli kısmı. Önceki prototiplerde şu hatalar yapıldı,
TEKRARLANMAMALI:
- ❌ Kuyruk modeli "geç kalan TTS'i kes, en güncel cue'ya atla" → cümle
  ortası kesiliyor, anlam kayboluyor.
- ❌ TTS üretimi cue geldiği anda başlıyor → API gecikmesi yüzünden ses
  altyazıdan geriden geliyor.
- ❌ Pre-fetch/lookahead mantığında bug: bir önceki bekleyen segment
  gereksiz yere iptal ediliyor, ara cümleler kayboluyor.

### İstenen Mimari: Slot-Based Pre-fetch Scheduler

1. **İki slotlu sistem**: `current` (şu an çalan/çalmaya hazır) ve `next`
   (bir sonraki, arka planda hazırlanıyor).
2. **Lookahead pre-fetch**: text-track modunda `track.cues` üzerinden bir
   sonraki cue'nun metni önceden bilinir. `current` slot çalmaya başladığı
   anda `next` slot için TTS isteği arka planda (asenkron, bloklamayan)
   başlatılır. DOM-caption modunda gerçek lookahead yok, segment geldiği an
   asenkron TTS başlatılır (decoupled pipeline).
3. **Hız adaptasyonu (computeIdealRate)**: her cue'nun zaman penceresi
   (`endTime - startTime`) bellidir. TTS sesi üretildiğinde süresi ölçülür
   (`audio.duration`).
   ```
   idealRate = audioDuration / cueWindowSeconds
   playbackRate = clamp(idealRate, 1.0, maxTtsRate)
   ```
   Kısa pencereye uzun cümle sığacaksa TTS hızlanır, rahatsa normal hızda okur.
4. **Video playbackRate farkındalığı**: kullanıcı videoyu 1.5x/2x oynatırsa,
   cue pencereleri de o hızda kısalır (video.currentTime ilerleme hızı
   değişir). Scheduler bunu `getActiveVideo().playbackRate` üzerinden
   her hesaplamaya dahil eder.
5. **İptal mekanizması**: her TTS isteği bir `AbortController`'a bağlıdır.
   - Kullanıcı seek/rewind yaparsa: aktif olmayan tüm slotlar iptal edilir,
     cache temizlenir.
   - Yeni segment gelirse ve `next` slot doluyken DAHA YENİ bir segment
     gelirse: sadece `next`'in zamanı geride kalmışsa (current.endTime'dan
     >1 saniye gecikmişse) `next` iptal edilip yenisiyle değiştirilir.
     Aksi halde `next` korunur (ara cümle kaybolmasın).
6. **Kuyruk derinliği max 2 slot** (current + next). Daha fazla biriktirme
   yapılmaz; aşırı lag durumunda en güncel cue'ya nazikçe atlanır ama bu
   SADECE gerçekten kullanıcı geride kaldığında (örn. >8 saniye lag) olur,
   normal akışta asla.
7. **Grace period'lar kısa tutulsun**: slot süre kontrolünde 80-120ms
   tolerans yeterli, fazlası gecikme hissi yaratır.
8. **Crossfade / yumuşak geçiş**: bir slot biterken yeni slot başlarken ani
   kesme yerine kısa (50-100ms) fade-out/fade-in uygulanabilir (Web Audio
   API GainNode ile), kulağa daha doğal gelir.

---

## 4. TTS (Seslendirme) — İki Motor Seçilebilir

### Browser TTS (Web Speech API)
- Ücretsiz, anında başlar, gecikme yok.
- Sistem seslerini listele, kullanıcı Türkçe ses seçebilsin (Microsoft
  Emel/Tolga gibi kaliteli sesler önerilsin).
- `estimateBrowserRate`: yukarıdaki computeIdealRate mantığıyla aynı
  şekilde hız hesaplanır, kelime sayısından tahmini süre çıkarılır.

### OpenAI TTS
- Daha doğal ses, ama API gecikmesi var (pre-fetch ile gizlenir).
- Model: `gpt-4o-mini-tts`. Ses seçenekleri: nova, onyx, shimmer, coral, fable.
- Kullanıcı özel "TTS talimatı" (instructions) yazabilsin (örn. "Akıcı ve
  doğal Türkçe konuş, teknik terimleri orijinal dilde söyle").
- API key yoksa otomatik Browser TTS'e düşülsün, kullanıcı uyarılsın.

### Telaffuz Sözlüğü
- Kullanıcı tanımlı: `backend=bekent`, `REST API=rest ey pi ay` gibi.
- Overlay'de görünen YAZILI metin değişmez, sadece TTS'e gönderilen metin
  bu sözlükle değiştirilir.

---

## 5. Ayarlar Sayfası (Options)

- DeepL API Key, kaynak dil (Otomatik / manuel liste)
- OpenAI API Key (opsiyonel)
- Dublaj motoru: Browser TTS / OpenAI TTS
- Browser sesi seçimi / OpenAI sesi seçimi
- OpenAI TTS talimatı (textarea)
- Teknik terim koruma listesi (textarea, `terim=terim` formatı)
- Telaffuz sözlüğü (textarea, `terim=okunuş` formatı)
- Maksimum dublaj hız katsayısı (slider, 1.0–3.0, varsayılan 2.5)
- Sync dubbing aç/kapa
- Orijinal video sesi seviyesi (ducking volume, dublaj sırasında, 0–1 slider)
- Overlay'de orijinal metni gösterme aç/kapa
- Kompakt overlay modu

---

## 6. Edge Case'ler — Test Edilmesi Gereken Senaryolar

- Video 1x → 1.5x → 2x hız değişimi sırasında TTS akıcı şekilde adapte olmalı
- İleri/geri sarma (seek) anında bekleyen TTS istekleri iptal edilmeli,
  yarım kalan ses kesilmeli, yeni pozisyondan akış başlamalı
- Video duraklatılırsa TTS de duraklamalı, devam edince akış bozulmamalı
- Video bitince tüm slotlar temizlenmeli, ducking geri alınmalı
- Çok hızlı ardışık cümlelerde (örn. tartışma sahnesi) cümleler kaybolmamalı,
  sırayla okunmalı
- Altyazı dili değiştirilirse (kullanıcı YouTube'da farklı dil seçerse)
  sistem yeni dili otomatik tespit edip çevirmeli
- Sekme arka plana alınırsa (audio dahil) ses kesilmemeli (mümkünse),
  MV3 service worker yaşam döngüsü buna göre yönetilmeli

---

## 7. Kalite Standardı

- HİÇBİR cümle sessizce atlanmamalı veya yarıda kesilmemeli (sync dubbing
  açıkken bile — sadece >8 saniye gerçek lag durumunda istisna)
- Ses üst üste binmemeli (iki TTS aynı anda çalmamalı)
- Hız adaptasyonu doğal sınırlar içinde olmalı (max 3x rate, bunun üstü
  anlaşılmaz olur)
- Her commit/değişiklik sonrası `node --check` ile syntax doğrulaması yapın

---

## Dosya Yapısı (önerilen)

```
manifest.json         MV3, izinler: storage, activeTab, tabs, scripting
background.js         Service worker: DeepL/OpenAI çağrıları, AbortController
                       yönetimi, prepareDub/tts-ready/tts-error mesajlaşması
content-youtube.js    YouTube'a özel caption capture + SPA navigation handling
content-udemy.js      Udemy'e özel caption capture (text-track + DOM fallback)
content-shared.js     Ortak: slot scheduler, computeIdealRate, overlay UI,
                       ducking, TTS playback (Browser + OpenAI)
content.css           Overlay stilleri
popup.html/js         Durum göster, başlat/durdur
options.html/js       Tüm ayarlar
```

## Geliştirme Sırası

1. Önce background.js + ortak slot scheduler mimarisini kur, syntax kontrolü
2. Udemy caption capture'ı entegre et (önceki projeden referans alınabilir)
3. YouTube caption capture'ı ekle (SPA navigation + DOM/track hybrid)
4. TTS motorlarını (Browser + OpenAI) bağla, hız adaptasyonunu test et
5. Ayarlar sayfasını oluştur
6. Edge case'leri tek tek test et, log'larla doğrula

Her adımda kodu node --check ile doğrula, dangling reference kalmadığından
emin ol, ve bana hangi fonksiyonların neyi çözdüğünü özetle.
