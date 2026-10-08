/**
 * Real YouTube titles (Hindi, Punjabi, Urdu, Spanish, Arabic, English uploads) and how they must
 * read — collected from the lyrics test runs, where a wrong parse meant wrong or missing lyrics.
 */
import { describe, expect, it } from 'vitest'
import { parseYouTubeTitle } from '../src/lib/format'

const artists = new Set(['arijitsingh', 'shilparao', 'jubinnautiyal', 'aseeskaur', 'alisethi', 'shaegill', 'mithoon'])
const films = new Set(['aashiqui2', 'jawan', 'shershaah', 'brahmastra', 'bhediya', 'kabirsingh'])
const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const ctx = { isKnownArtist: (n: string) => artists.has(key(n)), isKnownFilm: (n: string) => films.has(key(n)) }
const read = (raw: string, ch: string, c = ctx) => { const p = parseYouTubeTitle(raw, ch, c); return { title: p.title, artist: p.artist, album: p.album } }

describe('Hindi film uploads', () => {
  it('reads "Film: Song" from labels', () => {
    expect(read('Aashiqui 2: Tum Hi Ho 8K Full Song | Aditya Roy Kapur | Shraddha Kapoor | Arijit Singh | Mithoon', 'T-Series'))
      .toMatchObject({ title: 'Tum Hi Ho', album: 'Aashiqui 2', artist: 'Arijit Singh' })
    const j = read('JAWAN: Chaleya (Hindi) | Shah Rukh Khan | Nayanthara | Atlee | Anirudh | Arijit S, Shilpa R | Kumaar', 'T-Series', {})
    expect(j).toMatchObject({ title: 'Chaleya (Hindi)', album: 'Jawan', artist: 'Arijit S, Shilpa R' })
  })
  it('reads quoted song titles (HTML-escaped too)', () => {
    expect(read('&quot;Tum Hi Ho&quot; Aashiqui 2 Full Song With Lyrics | Aditya Roy Kapur, Shraddha Kapoor', 'T-Series'))
      .toMatchObject({ title: 'Tum Hi Ho', album: 'Aashiqui 2' })
    expect(read('"Tum Hi Ho Aashiqui 2" Full Video Song HD | Aditya Roy Kapur, Shraddha Kapoor | Music - Mithoon', 'T-Series'))
      .toMatchObject({ title: 'Tum Hi Ho', album: 'Aashiqui 2' })
    expect(read('Tum Hi Ho Song Aashiqui 2 | Music By Mithoon | Aditya Roy Kapur, Shraddha Kapoor', 'T-Series'))
      .toMatchObject({ title: 'Tum Hi Ho', album: 'Aashiqui 2' })
  })
  it('reads casts written with an en dash and 8K/4K tags', () => {
    expect(read('Raataan Lambiyan – Official Video | Shershaah | Sidharth – Kiara | Tanishk B| Jubin Nautiyal  |Asees', 'Sony Music India'))
      .toMatchObject({ title: 'Raataan Lambiyan', album: 'Shershaah', artist: 'Jubin Nautiyal' })
    expect(read('Raataan Lambiyan - 8K/4K Music Video | Sidharth Malhotra, Kiara Advani | Jubin, Asees | Shershaah', 'Sony Music India'))
      .toMatchObject({ title: 'Raataan Lambiyan', album: 'Shershaah', artist: 'Jubin, Asees' })
    expect(read('Kesariya 8K/4K Music Video | Arijit Singh | Ranbir Kapoor | Alia Bhatt | Pritam | Brahmāstra', 'Sony Music India').title).toBe('Kesariya')
  })
  it('treats VEVO label channels as labels and "Film Version" as a version', () => {
    expect(read('Raataan Lambiyan - Shershaah | Full Song | Sidharth, Kiara | Tanishk B, Jubin, Asees', 'SonyMusicIndiaVEVO'))
      .toMatchObject({ title: 'Raataan Lambiyan', album: 'Shershaah' })
    expect(read('Kesariya - Film Version | Brahmāstra | Ranbir | Alia | Pritam | Arijit | Amitabh', 'SonyMusicIndiaVEVO').title).toBe('Kesariya (Film Version)')
  })
  it('finds the singer by name among cast and crew', () => {
    expect(read('Apna Bana Le 8K Video | Arijit Singh | Bhediya | Varun Dhawan &amp; Kriti Sanon | Sachin-Jigar, Amitabh', 'Zee Music Company'))
      .toMatchObject({ title: 'Apna Bana Le', artist: 'Arijit Singh', album: 'Bhediya' })
    expect(read('Apna Bana Le - Full Audio | Bhediya | Varun Dhawan, Kriti Sanon| Sachin-Jigar,Arijit Singh,Amitabh B', 'Zee Music Company').title).toBe('Apna Bana Le')
  })
  it('reads "Song - Film" on lyrics and fan channels when the film is known', () => {
    expect(read('Chaleya (Lyrics) - Jawan | Shah Rukh Khan | Nayanthara | Atlee, Anirudh | Arijit Singh | Shilpa Rao', 'Love & Lyrics'))
      .toMatchObject({ title: 'Chaleya', album: 'Jawan', artist: 'Arijit Singh, Shilpa Rao' })
    expect(read('Kesariya (Lyrics) Full Song - Brahmastra | Arijit Singh | Kesariya Tera Ishq Hai Piya', '7clouds'))
      .toMatchObject({ title: 'Kesariya', album: 'Brahmastra', artist: 'Arijit Singh' })
    expect(read('Apna Bana Le - Bhediya | Varun Dhawan, Kriti Sanon| Sachin-Jigar, Arijit Singh, Amitabh Bhattacharya', 'Romance Rewind'))
      .toMatchObject({ title: 'Apna Bana Le', album: 'Bhediya', artist: 'Arijit Singh' })
  })
})

describe('shows and sessions', () => {
  it('reads Coke Studio titles', () => {
    expect(read('Coke Studio | Season 14 | Pasoori | Ali Sethi x Shae Gill', 'Coke Studio Pakistan'))
      .toEqual({ title: 'Pasoori', artist: 'Ali Sethi, Shae Gill', album: 'Coke Studio Season 14' })
    expect(read('Coke Studio 14 | Pasoori | The Magical Journey', 'Coke Studio Pakistan')).toMatchObject({ title: 'Pasoori', album: 'Coke Studio 14' })
    expect(read('Pasoori | Ali Sethi, Shae Gill | Coke Studio | Lyrics', 'zaini lyrics', {})).toMatchObject({ title: 'Pasoori', artist: 'Ali Sethi, Shae Gill' })
  })
})

describe('Punjabi, Spanish, Arabic and English uploads', () => {
  it('keeps the usual "Artist - Song" reading', () => {
    expect(read('AP Dhillon - Brown Munde (Official Music Video)', 'AP Dhillon', {})).toMatchObject({ artist: 'AP Dhillon', title: 'Brown Munde' })
    expect(read('Luis Fonsi - Despacito ft. Daddy Yankee', 'LuisFonsiVEVO', {})).toMatchObject({ artist: 'Luis Fonsi', title: 'Despacito ft. Daddy Yankee' })
    expect(read('Saad Lamjarred - LM3ALLEM (Exclusive Music Video) | (سعد لمجرد - لمعلم (فيديو كليب حصري', 'Saad Lamjarred | سعد لمجرد', {}).title).toBe('LM3ALLEM')
    expect(read('The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO', {})).toMatchObject({ artist: 'The Weeknd', title: 'Blinding Lights' })
  })
  it('reads Punjabi uploads on artist and producer channels', () => {
    expect(read('BROWN MUNDE - AP DHILLON | GURINDER GILL | SHINDA KAHLON (Official Music Video)', 'APDHILLON', {})).toMatchObject({ title: 'BROWN MUNDE', artist: 'AP Dhillon' })
    expect(read('Brown Munde - Ap Dhillon , Gurinder Gill , Shinda Kahlon | Hit Punjabi Songs', 'Sagar Studioz', {})).toMatchObject({ title: 'Brown Munde', artist: 'Ap Dhillon , Gurinder Gill , Shinda Kahlon' })
    expect(read('Excuses (Official Video) | AP Dhillon | Gurinder Gill | Intense', 'Intense', {})).toMatchObject({ title: 'Excuses', artist: 'AP Dhillon, Gurinder Gill' })
    expect(read('Diljit Dosanjh: LOVER (Official Music Video) Intense | Raj Ranjodh | MoonChild Era', 'Diljit Dosanjh', {})).toMatchObject({ title: 'LOVER', artist: 'Diljit Dosanjh' })
    expect(read('LOVER: Diljit Dosanjh (Official Audio) Intense | Raj Ranjodh | MoonChild Era | Latest Song 2021', 'Diljit Dosanjh', {})).toMatchObject({ title: 'LOVER', artist: 'Diljit Dosanjh' })
    expect(read('SOFTLY (Official Music Video) KARAN AUJLA | IKKY | LATEST PUNJABI SONGS 2023', 'Karan Aujla', {})).toMatchObject({ title: 'SOFTLY', artist: 'Karan Aujla' })
    expect(read('Excuses - AP Dhillon, Gurinder Gill &amp; Intense Music (Lyric Video) by RMN NATÎ0N', 'RMN NATÎ0N', {})).toMatchObject({ title: 'Excuses' })
  })
  it('reads Spanish uploads', () => {
    expect(read('La Bachata - MTZ Manuel Turizo | Video Oficial', 'Manuel Turizo', {})).toMatchObject({ title: 'La Bachata', artist: 'Manuel Turizo' })
    expect(read('SHAKIRA || BZRP Music Sessions #53 (Official Video)', 'Jazpix', {})).toMatchObject({ title: 'Bzrp Music Sessions, Vol. 53', artist: 'Bizarrap, Shakira' })
    expect(read('Shakira, Bizarrap - Bzrp Music Sessions, Vol. 53 (Letra/Lyrics)', 'Watermelon Music', {})).toMatchObject({ title: 'Bzrp Music Sessions, Vol. 53', artist: 'Bizarrap, Shakira' })
    expect(read('Bad Bunny ft. Chencho Corleone - Me Porto Bonito (Video Oficial) | Un Verano Sin Ti', 'Bad Bunny', {})).toMatchObject({ title: 'Me Porto Bonito' })
  })
  it('reads Arabic uploads', () => {
    expect(read('@AmrDiab - Tamally Maak | Official Music Video - HD Version | عمرو دياب - تملي معاك', 'Mazzika - مزيكا', {})).toMatchObject({ title: 'Tamally Maak', artist: 'Amr Diab', album: null })
    expect(read('Nancy Ajram - Enta Eih (Official Music Video) / نانسي عجرم - انت ايه', 'Nancy Ajram', {})).toMatchObject({ title: 'Enta Eih', artist: 'Nancy Ajram' })
    expect(read('Enta Eih - Nancy Ajram (Transliteration + Translation)', 'LyricallyConnected', { isKnownArtist: (n: string) => key(n) === 'nancyajram' })).toMatchObject({ title: 'Enta Eih', artist: 'Nancy Ajram' })
    expect(read('Amr Diab ~ Habibi Ya Nour El Ain', 'nmklqw', {})).toMatchObject({ title: 'Habibi Ya Nour El Ain', artist: 'Amr Diab' })
    expect(read('Saad Lamjarred - LM3ALLEM (Exclusive Music Video) |  (سعد لمجرد - لمعلم (فيديو كليب حصري', 'Saad Lamjarred | سعد لمجرد', {})).toMatchObject({ title: 'LM3ALLEM', artist: 'Saad Lamjarred' })
  })
  it('reads label-free Arabic titles', () => {
    expect(read('عمرو دياب - تملي معاك', 'Amr Diab', {})).toMatchObject({ artist: 'عمرو دياب', title: 'تملي معاك' })
  })
})
