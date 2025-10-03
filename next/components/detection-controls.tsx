'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Button, IconButton } from '@radix-ui/themes'
import { useEditorStore, TextBlock } from '@/lib/state'

export default function DetectionControls() {
  const { image, textBlocks, setTextBlocks, selectedBlockIndex, setSelectedBlockIndex } = useEditorStore()

  const handleAddTextArea = () => {
    if (!image) return

    // Add a new text block in the center of the image
    const centerX = image.bitmap.width / 2
    const centerY = image.bitmap.height / 2
    const defaultSize = 100

    const newBlock: TextBlock = {
      xmin: centerX - defaultSize / 2,
      ymin: centerY - defaultSize / 2,
      xmax: centerX + defaultSize / 2,
      ymax: centerY + defaultSize / 2,
      confidence: 1.0,
      class: 0, // Default to black text
    }

    setTextBlocks([...textBlocks, newBlock])
    setSelectedBlockIndex(textBlocks.length)
  }

  const handleDeleteSelected = () => {
    if (selectedBlockIndex === null) return

    const updated = textBlocks.filter((_, i) => i !== selectedBlockIndex)
    setTextBlocks(updated)
    setSelectedBlockIndex(null)
  }

  return (
    <div className='flex items-center gap-2'>
      <Button
        size='2'
        variant='soft'
        onClick={handleAddTextArea}
        disabled={!image}
        title='Add manual text area'
      >
        <Plus size={16} />
        Add Area
      </Button>
      <IconButton
        size='2'
        variant='soft'
        color='red'
        onClick={handleDeleteSelected}
        disabled={selectedBlockIndex === null}
        title='Delete selected text area'
      >
        <Trash2 size={16} />
      </IconButton>
      {selectedBlockIndex !== null && (
        <span className='text-sm text-gray-600 dark:text-gray-400'>
          Block #{selectedBlockIndex + 1} selected
        </span>
      )}
    </div>
  )
}
