import { describe, expect, it } from 'vitest'
import { guessLanguage } from '../src/lib/lyrics'

// Made-up lines (not real lyrics) — just enough text in each language for the guess.
describe('guessLanguage', () => {
  it('reads English', () => {
    expect(guessLanguage(['I walk to the station in the rain', 'and you know that I wait for you', 'all of my days are so slow when you go'])).toBe('English')
  })
  it('reads Spanish', () => {
    expect(guessLanguage(['Camino por la calle de noche', 'y pienso que tú no estás aquí', 'quiero ver el mar con mi amor'])).toBe('Spanish')
  })
  it('reads French', () => {
    expect(guessLanguage(['Je marche dans la ville avec toi', 'et le ciel est gris sur nous', "c'est pas la fin pour moi"])).toBe('French')
  })
  it('reads German', () => {
    expect(guessLanguage(['Ich gehe durch die Stadt mit dir', 'und es ist so still in mir', 'wenn du nicht bei mir bist'])).toBe('German')
  })
  it('reads Hindi written in Latin letters', () => {
    expect(guessLanguage(['Tum ho to dil mera khush hai', 'main yahan hoon tere liye', 'kya hai yeh jo mujhe hua'])).toBe('Hindi')
  })
  it('reads scripts', () => {
    expect(guessLanguage(['मैं चलता हूँ रात में अकेले', 'तुम कहाँ हो आज'])).toBe('Hindi')
    expect(guessLanguage(['밤에 혼자 걸어가요 너를 생각해', '오늘도 비가 내려요'])).toBe('Korean')
    expect(guessLanguage(['夜の街をひとりで歩いている', 'きみのことを考えてる'])).toBe('Japanese')
  })
  it('is unsure about too little text', () => {
    expect(guessLanguage(['oh oh oh', 'la la'])).toBeNull()
  })
})
