import { guessContentType, isImageMime, isTextExtension, isTextMime } from '../../src/utils/content-type'

describe('content-type', () => {
  describe('guessContentType', () => {
    it('should return correct MIME for text file extensions (without dot)', () => {
      expect(guessContentType('txt')).toBe('text/plain')
      expect(guessContentType('md')).toBe('text/markdown')
      expect(guessContentType('csv')).toBe('text/csv')
      expect(guessContentType('tsv')).toBe('text/tab-separated-values')
      expect(guessContentType('html')).toBe('text/html')
      expect(guessContentType('css')).toBe('text/css')
      expect(guessContentType('log')).toBe('text/plain')
    })

    it('should return correct MIME for application types', () => {
      expect(guessContentType('json')).toBe('application/json')
      expect(guessContentType('xml')).toBe('application/xml')
      expect(guessContentType('yaml')).toBe('application/yaml')
      expect(guessContentType('yml')).toBe('application/yaml')
      expect(guessContentType('toml')).toBe('application/toml')
      expect(guessContentType('js')).toBe('application/javascript')
      expect(guessContentType('ts')).toBe('application/typescript')
      expect(guessContentType('sql')).toBe('application/sql')
      expect(guessContentType('sh')).toBe('application/x-sh')
      expect(guessContentType('pdf')).toBe('application/pdf')
      expect(guessContentType('zip')).toBe('application/zip')
      expect(guessContentType('gz')).toBe('application/gzip')
      expect(guessContentType('tar')).toBe('application/x-tar')
    })

    it('should return correct MIME for programming languages', () => {
      expect(guessContentType('py')).toBe('text/x-python')
      expect(guessContentType('rb')).toBe('text/x-ruby')
      expect(guessContentType('java')).toBe('text/x-java')
      expect(guessContentType('go')).toBe('text/x-go')
      expect(guessContentType('rs')).toBe('text/x-rust')
      expect(guessContentType('c')).toBe('text/x-c')
      expect(guessContentType('cpp')).toBe('text/x-c++')
    })

    it('should return correct MIME for image types', () => {
      expect(guessContentType('png')).toBe('image/png')
      expect(guessContentType('jpg')).toBe('image/jpeg')
      expect(guessContentType('jpeg')).toBe('image/jpeg')
      expect(guessContentType('gif')).toBe('image/gif')
      expect(guessContentType('webp')).toBe('image/webp')
      expect(guessContentType('svg')).toBe('image/svg+xml')
    })

    it('should return correct MIME for Office documents', () => {
      expect(guessContentType('doc')).toBe('application/msword')
      expect(guessContentType('docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      expect(guessContentType('xls')).toBe('application/vnd.ms-excel')
      expect(guessContentType('xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      expect(guessContentType('pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    })

    it('should handle filename with dots (extracts extension)', () => {
      expect(guessContentType('document.txt')).toBe('text/plain')
      expect(guessContentType('data.json')).toBe('application/json')
      expect(guessContentType('image.png')).toBe('image/png')
      expect(guessContentType('report.pdf')).toBe('application/pdf')
      expect(guessContentType('archive.tar.gz')).toBe('application/gzip')
    })

    it('should handle case-insensitive extensions via filename', () => {
      expect(guessContentType('FILE.TXT')).toBe('text/plain')
      expect(guessContentType('IMAGE.PNG')).toBe('image/png')
    })

    it('should return application/octet-stream for unknown extensions', () => {
      expect(guessContentType('xyz')).toBe('application/octet-stream')
      expect(guessContentType('')).toBe('application/octet-stream')
      expect(guessContentType('unknown.abc')).toBe('application/octet-stream')
    })
  })

  describe('isTextExtension', () => {
    it('should return true for common text extensions', () => {
      expect(isTextExtension('txt')).toBe(true)
      expect(isTextExtension('md')).toBe(true)
      expect(isTextExtension('json')).toBe(true)
      expect(isTextExtension('ts')).toBe(true)
      expect(isTextExtension('py')).toBe(true)
      expect(isTextExtension('env')).toBe(true)
      expect(isTextExtension('prisma')).toBe(true)
      expect(isTextExtension('tf')).toBe(true)
      expect(isTextExtension('hcl')).toBe(true)
      expect(isTextExtension('proto')).toBe(true)
    })

    it('should return false for non-text extensions', () => {
      expect(isTextExtension('png')).toBe(false)
      expect(isTextExtension('pdf')).toBe(false)
      expect(isTextExtension('zip')).toBe(false)
      expect(isTextExtension('exe')).toBe(false)
      expect(isTextExtension('doc')).toBe(false)
    })

    it('should be case-insensitive', () => {
      expect(isTextExtension('TXT')).toBe(true)
      expect(isTextExtension('Json')).toBe(true)
    })
  })

  describe('isTextMime', () => {
    it('should return true for text/* MIME types', () => {
      expect(isTextMime('text/plain')).toBe(true)
      expect(isTextMime('text/html')).toBe(true)
      expect(isTextMime('text/markdown')).toBe(true)
    })

    it('should return true for application MIME types that are text', () => {
      expect(isTextMime('application/json')).toBe(true)
      expect(isTextMime('application/xml')).toBe(true)
      expect(isTextMime('application/javascript')).toBe(true)
      expect(isTextMime('application/typescript')).toBe(true)
      expect(isTextMime('application/yaml')).toBe(true)
      expect(isTextMime('application/x-sh')).toBe(true)
      expect(isTextMime('application/sql')).toBe(true)
      expect(isTextMime('application/toml')).toBe(true)
      expect(isTextMime('application/graphql')).toBe(true)
    })

    it('should return false for non-text MIME types', () => {
      expect(isTextMime('image/png')).toBe(false)
      expect(isTextMime('application/pdf')).toBe(false)
      expect(isTextMime('application/zip')).toBe(false)
      expect(isTextMime('application/octet-stream')).toBe(false)
    })
  })

  describe('isImageMime', () => {
    it('should return true for image/* MIME types', () => {
      expect(isImageMime('image/png')).toBe(true)
      expect(isImageMime('image/jpeg')).toBe(true)
      expect(isImageMime('image/gif')).toBe(true)
      expect(isImageMime('image/svg+xml')).toBe(true)
    })

    it('should return false for non-image MIME types', () => {
      expect(isImageMime('text/plain')).toBe(false)
      expect(isImageMime('application/pdf')).toBe(false)
    })
  })
})
