export default function SplashScreen() {
  return (
    <div className='flex h-screen w-screen flex-col items-center justify-center bg-gradient-to-br from-gray-50 via-white to-rose-50/30'>
      <div
        className='flex flex-col items-center'
        style={{ animation: 'fade-in-up 0.6s ease-out both' }}
      >
        {/* Glow ring */}
        <div
          className='mb-6 flex h-20 w-20 items-center justify-center rounded-full'
          style={{
            background: 'linear-gradient(135deg, rgba(224,17,95,.08), rgba(224,17,95,.02))',
            animation: 'koharu-glow 2.5s ease-in-out infinite',
          }}
        >
          {/* Spinner */}
          <div
            className='h-10 w-10 rounded-full border-2 border-[#E0115F]/20 border-t-[#E0115F]'
            style={{ animation: 'spin-slow 1s linear infinite' }}
          />
        </div>
        <h1
          className='mb-1.5 text-3xl font-bold tracking-tight text-[#E0115F]'
          style={{ animation: 'koharu-pulse 2.5s ease-in-out infinite' }}
        >
          Koharu
        </h1>
        <p className='text-xs font-medium tracking-widest text-[#E0115F]/50 uppercase'>
          Initializing
        </p>
      </div>
    </div>
  )
}
