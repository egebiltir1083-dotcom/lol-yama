# lol-yama-data: otomatik yama verisi

Bu depo, **LoL Yama Asistanı** eklentisi için yama verisini kendi kendine günceller. GitHub'ın ücretsiz zamanlanmış görevi (GitHub Actions) her 3 saatte bir şunu yapar:

1. Riot'un Türkçe yama notu sayfasında yeni yama var mı diye bakar (26.22, 26.23 …).
2. Yeni yama varsa metni Claude API'ye gönderip şampiyon, eşya, ARAM Şamata, Classic, Arena, kostüm ve hata başlıklarına ayırtır.
3. Sonucu doğrular (aşağıya bak), `data/` klasörüne yazar.
4. Son iki yamanın sayfası değiştiyse (yama ortası güncelleme) onu yeniden işler.

Eklenti `data/index.json`, `data/latest.json` ve `data/history.json` dosyalarını okur. Terminal gerekmez; her şey GitHub'ın web arayüzünden kurulur.

## Kurulum (yaklaşık 15 dakika)

**1. Depo aç.** github.com'da giriş yap → sağ üstte **+** → **New repository** → ad: `lol-yama-data` → **Public** → **Create repository**. (Public olmalı; eklenti dosyaları `raw.githubusercontent.com` üzerinden okur.)

**2. Dosyaları yükle.** Açılan boş depoda **uploading an existing file** bağlantısına tıkla. Zip'ten çıkardığın `lol-yama-data` klasörünün **içindekileri** (`scripts`, `data`, `test` klasörleri, `package.json`, `README.md`) sürükle bırak → **Commit changes**.

**3. İş akışı dosyasını elle oluştur.** `.github` gibi noktayla başlayan klasörler çoğu zaman sürüklemeyle yüklenmez. Depoda **Add file → Create new file** de. Dosya adı kutusuna aynen şunu yaz: `.github/workflows/update.yml` (`/` yazdıkça klasör oluşur). İçine `workflow-kopyasi/update.yml` dosyasının tamamını yapıştır → **Commit changes**.

**4. API anahtarını ekle.** console.anthropic.com'da bir API anahtarı oluştur (Claude uygulamasındaki abonelikten ayrı faturalanır; hesapta kredi olmalı ve bir **aylık harcama limiti** koymanı öneririm). Sonra GitHub'da depoda **Settings → Secrets and variables → Actions → New repository secret**: ad `ANTHROPIC_API_KEY`, değer anahtarın. Anahtarı kimseyle paylaşma, dosyalara yazma.

**5. Yazma iznini aç.** **Settings → Actions → General → Workflow permissions → Read and write permissions → Save.**

**6. İlk çalıştırma.** **Actions** sekmesi → solda **Yama güncelle** → **Run workflow**. `backfill` kutusuna `5` yaz (son 5 yamanın geçmişini oluşturur) → **Run workflow**. Birkaç dakika sonra yeşil tik çıkar ve `data/patches/` altında yama dosyaları belirir. Kırmızı çarpı çıkarsa işe tıkla; hata mesajı Türkçe ve ne yapılacağını söyler.

**7. Eklentiye bağla.** Eklenti klasöründeki `common.js` dosyasında şu satırı bul:

```js
const REMOTE_BASE = '';
```

ve şöyle yap (KULLANICI_ADIN yerine GitHub kullanıcı adın):

```js
const REMOTE_BASE = 'https://raw.githubusercontent.com/KULLANICI_ADIN/lol-yama-data/main/data';
```

Sonra `chrome://extensions` sayfasında eklentinin yenile düğmesine bas. Yama sekmesinde "Otomatik güncelleme açık" yazısını görmelisin.

## Güvenlik ağları

- **Sayı kontrolü:** Modelin yazdığı her sayı kaynak yama notunda geçmeli. Birkaç uyuşmazlık uyarı olarak kaydedilir (`_meta.uyarilar`); kayıtların %15'inden fazlasında varsa yama **reddedilir** ve eski veri korunur. Bu kaba bir kontroldür: sayıların doğru şampiyona bağlandığını doğrulamaz. Karışık değişiklikler ("buff" mı "nerf" mi) için model "ayar" yazmaya yönlendirilir ama yorum yine de modele aittir.
- **Hatalı çıktı:** Geçersiz JSON ya da doğrulama hatasında bir kez yeniden dener; yine olmazsa o yamayı yazmaz, işi kırmızı yapar (GitHub e-posta gönderir).
- **Site sorunları:** Riot sayfasına ulaşılamazsa ya da sayfadan metin çıkarılamazsa iş hata verir ve veri bozulmaz.
- **Prompt injection:** Yama sayfası güvenilmez veri olarak işaretlenir; eklenti de gelen metni HTML olarak değil düz metin olarak gösterir.

## Bilmen gerekenler

- Bu betikleri **sahte bir Riot sitesi ve sahte Claude yanıtlarıyla** test ettim (19 test). Gerçek Riot sitesiyle ve gerçek API ile henüz çalıştırılmadı. İlk gerçek çalıştırma bir sınav: Riot'un sitesi GitHub sunucularından gelen istekleri engelliyor olabilir ya da sayfa yapısı beklediğimden farklı olabilir. Böyle olursa hata mesajı bunu söyler ve çözeriz.
- Maliyet yamada bir API çağrısı (ve yama ortası güncellemede bir tane daha). Güncel fiyatı console.anthropic.com'dan kontrol et; limit koy.
- GitHub, 60 gün hiç etkinlik olmayan depolarda zamanlanmış işleri kapatır. Betik haftada bir `son_kontrol` alanını güncelleyip commit atarak bunu önler.
- `data/patches/26.21.json` elle hazırlanmış tohum veridir. İlk çalıştırmada yalnızca kaynak özeti kaydedilir, yeniden işlenmez.
- Özetlenen metin Riot'a aittir; her kayıt orijinal sayfaya bağlantı taşır. Metni olduğu gibi kopyalamıyoruz, özetliyoruz.

## Elle komutlar (isteğe bağlı, Node 20+)

```
node scripts/update.mjs                 normal çalışma
node scripts/update.mjs --backfill 5    toplam 5 yamalık geçmiş
node scripts/update.mjs --patch 26.22   bir yamayı zorla yeniden işle
node scripts/update.mjs --rebuild       ağsız; index/latest/history yeniden üretir
npm test                                testler
```

Ortam değişkenleri: `ANTHROPIC_API_KEY` (zorunlu), `CLAUDE_MODEL` (varsayılan `claude-sonnet-5-5`), `START_PATCH` (boş depoda başlangıç yaması, varsayılan `26.21`).
