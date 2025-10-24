'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Button, IconButton } from '@radix-ui/themes'
import { useEditorStore } from '@/lib/state'

export default function DetectionControls() {
  const {
    textBlocks,
    setTextBlocks,
    selectedBlockIndex,
    setSelectedBlockIndex,
    addTextAreaHandler,
    setSelectedBlockId,
  } = useEditorStore()

  const handleAddTextArea = () => {
    // Use the handler from canvas which has access to viewport transform
    if (addTextAreaHandler) {
      addTextAreaHandler()
    }
  }

  const handleDeleteSelected = () => {
    if (selectedBlockIndex === null) return

    const updated = textBlocks.filter((_, i) => i !== selectedBlockIndex)
    setTextBlocks(updated)
    setSelectedBlockIndex(null)
    setSelectedBlockId(null)
  }

  return (
    <div className='flex items-center gap-2'>
      <Button
        size='2'
        variant='soft'
        onClick={handleAddTextArea}
        disabled={!addTextAreaHandler}
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
